import { InjectQueue, Process, Processor } from '@nestjs/bull';
import {
  Inject,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, Queue } from 'bull';
import tgrConfig from '../config/tgr.config';
import { prefixQueue } from '../config/queue-prefix';
import {
  TGR_GROUP_MISSING,
  TGR_PUBLISH_ACK,
  type TgrGroupMissingPayload,
  type TgrPublishAckPayload,
} from '../events';
import { NIP29_KIND } from '../nostr/nip29';
import { RELAY_WRITER } from '../nostr/relay-writer.contract';
import type { RelayWriter } from '../nostr/relay-writer.contract';
import type { PublishNip29Job } from './publish-nip29.types';
import {
  isAlreadyExists,
  isGroupNotFound,
  isTerminalReject,
  pubkeyFromTags,
  TerminalPublishError,
} from './publish-policy';
import { TokenBucket } from './token-bucket';

/** Resolved queue name (`worker:publish-nip29`) — registered worker-side. */
export const PUBLISH_NIP29_QUEUE = prefixQueue('publish-nip29', 'worker');

/**
 * Concurrency must be a decorator-time constant; default to §18's `2`. The actual
 * runtime cap on parallel ACK waits comes from `TG_PUBLISH_CONCURRENCY`; the
 * token-bucket then smooths the publish rate across those slots.
 */
export const PUBLISH_NIP29_CONCURRENCY = Number(
  process.env.TG_PUBLISH_CONCURRENCY || 2,
);

/**
 * Consumer for `worker:publish-nip29` (Task 07 §4).
 *
 * The single publish path: take a token-bucket slot, publish through the
 * relay-admin connection, wait for the relay ACK, classify the outcome, and emit
 * `tgr.publish.ack` exactly once per settled job. This is the SOLE owner of the
 * `tgr.publish.ack` emit; Tasks 10/11 consume that event — they never read ACKs.
 *
 * Idempotency is relay-owned (no process-local cache): a duplicate `9007`
 * resolves successfully via the already-exists predicate (§6.2). Retry/backoff
 * is configured on the enqueued job (`attempts` + capped-exponential `backoff`);
 * terminal rejects fail fast without exhausting retries.
 */
@Processor(PUBLISH_NIP29_QUEUE)
export class PublishNip29Processor
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PublishNip29Processor.name);
  private readonly bucket: TokenBucket;
  private resumeTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    @Inject(RELAY_WRITER)
    private readonly relay: RelayWriter,
    private readonly eventEmitter: EventEmitter2,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
    @InjectQueue(PUBLISH_NIP29_QUEUE)
    private readonly queue: Queue<PublishNip29Job>,
  ) {
    // One shared bucket per worker (across all concurrency slots), §4.
    this.bucket = new TokenBucket(this.config.publishRatePerSec);
  }

  /**
   * Clear a STALE pause on boot. {@link pauseForOutage} pauses the queue in Redis
   * (durable) but the resume loop ({@link armResume}/{@link tryResume}) is purely
   * in-memory — so if the process restarts while the queue is paused, the pause
   * survives in Redis with no live timer to lift it, and the queue stays paused
   * FOREVER (every publish — room creates + member adds — backs up unprocessed).
   * Resuming here is idempotent and safe: if the relay is genuinely down, the first
   * publish fails and `pauseForOutage` re-pauses WITH a fresh in-memory resume loop
   * that this live process will honor. Runs after `onModuleInit` (the relay writer
   * has connected by `OnApplicationBootstrap`).
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      if (await this.queue.isPaused()) {
        const counts = await this.queue.getJobCounts();
        await this.queue.resume();
        this.logger.warn(
          `resumed a stale-paused publish queue on boot ` +
            `(${JSON.stringify(counts)} — these were stuck unprocessed)`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `failed to check/resume queue on boot: ${(e as Error)?.message}`,
      );
    }
  }

  @Process({ concurrency: PUBLISH_NIP29_CONCURRENCY })
  async process(job: Job<PublishNip29Job>): Promise<{ id?: string }> {
    const { template, groupId, meta } = job.data;
    const saleAddress = meta?.saleAddress ?? groupId;
    const pubkey = pubkeyFromTags(template.tags);

    // Health gating (§1.3 / §4): if the relay is down, pause the queue for the
    // configured window and re-throw so Bull re-attempts AFTER the pause — we do
    // NOT retry-spin against a dead socket.
    if (!this.relay.isHealthy()) {
      await this.pauseForOutage();
      throw new Error('relay unhealthy; paused publishes');
    }

    // Token-bucket rate limit, shared across the worker's concurrency slots.
    await this.bucket.take();

    const result = await this.relay.publish(template);

    if (result.ok) {
      this.emitAck(saleAddress, template.kind, pubkey, true);
      return { id: result.id };
    }

    const reason = result.reason ?? 'publish failed';

    // Reject classification ---------------------------------------------------
    if (isAlreadyExists(reason)) {
      // Resumable-backfill no-op (§6.2): treat as success, do not retry.
      this.logger.debug(
        `publish kind ${template.kind} for ${groupId}: already exists (no-op)`,
      );
      this.emitAck(saleAddress, template.kind, pubkey, true);
      return { id: result.id };
    }

    if (isTerminalReject(reason)) {
      // Permanent (D7 / 9008-deleted): fail fast, surface for alerting, ack false.
      this.logger.error(
        `terminal publish reject kind ${template.kind} for ${groupId}: ${reason}`,
      );
      this.emitAck(saleAddress, template.kind, pubkey, false);
      throw new TerminalPublishError(reason);
    }

    if (isGroupNotFound(reason)) {
      // The relay has no such group (DB↔relay desync — e.g. the relay was reset)
      // while the DB still marks the room created. Retrying member ops is futile
      // until the group is re-created, so do NOT retry-spam: `discard()` this job,
      // and route by intent:
      //   • 9001 remove / 9008 delete → the desired ABSENCE is already satisfied by
      //     the group being gone → ack success (no re-create needed).
      //   • 9000 add / 9002 metadata / 9006 role → ask the owner to re-create the
      //     group (TGR_GROUP_MISSING → a queued 9007, debounced per group) and leave
      //     the member `pending`; it is re-added once the group is back (the 9007
      //     ok-ACK re-fires tgr.room.created → publishPendingForRoom).
      if (
        template.kind === NIP29_KIND.REMOVE_USER ||
        template.kind === NIP29_KIND.DELETE_GROUP
      ) {
        this.logger.debug(
          `group ${groupId} not found for kind ${template.kind} — absence already satisfied`,
        );
        this.emitAck(saleAddress, template.kind, pubkey, true);
        return { id: result.id };
      }
      job.discard();
      this.eventEmitter.emit(TGR_GROUP_MISSING, {
        saleAddress,
      } as TgrGroupMissingPayload);
      this.logger.debug(
        `group ${groupId} missing on relay → requested re-create; kind ${template.kind} deferred (member stays pending)`,
      );
      this.emitAck(saleAddress, template.kind, pubkey, false);
      throw new Error(reason);
    }

    // ACK timeout: pause the queue (relay likely unreachable) before failing so
    // Bull's backoff doesn't fire into a dead relay.
    if (result.timedOut) {
      await this.pauseForOutage();
    }

    // Retryable: throw so Bull re-attempts with its configured backoff. Emit a
    // failure ack ONLY when retries are exhausted (this is the last attempt).
    if (this.isLastAttempt(job)) {
      this.logger.error(
        `publish kind ${template.kind} for ${groupId} exhausted retries: ${reason}`,
      );
      this.emitAck(saleAddress, template.kind, pubkey, false);
    } else {
      this.logger.warn(
        `publish kind ${template.kind} for ${groupId} failed (will retry): ${reason}`,
      );
    }
    throw new Error(reason);
  }

  /** Emit the single-source-of-truth `tgr.publish.ack` (§4 publish ACK seam). */
  private emitAck(
    saleAddress: string,
    kind: number,
    pubkey: string | undefined,
    ok: boolean,
  ): void {
    const payload: TgrPublishAckPayload = { saleAddress, kind, ok };
    if (pubkey) {
      payload.pubkey = pubkey;
    }
    this.eventEmitter.emit(TGR_PUBLISH_ACK, payload);
  }

  /** Pause the queue for `relayHealthPauseSec`, then resume (best-effort). */
  private async pauseForOutage(): Promise<void> {
    try {
      const alreadyPaused = await this.queue.isPaused();
      if (!alreadyPaused) {
        await this.queue.pause();
        this.logger.warn(
          `relay outage: paused ${PUBLISH_NIP29_QUEUE} for ${this.config.relayHealthPauseSec}s`,
        );
      }
    } catch (e) {
      this.logger.warn(`failed to pause queue: ${(e as Error)?.message}`);
    }
    // Arm a single resume loop that retries until the relay is healthy again.
    // Fire and forget — Bull holds the (re-thrown) job until the queue resumes.
    this.armResume();
  }

  /** Arm the resume timer (at most one outstanding loop). */
  private armResume(): void {
    if (this.resumeTimer || this.stopped) {
      return;
    }
    const pauseMs = Math.max(1, this.config.relayHealthPauseSec) * 1000;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      void this.tryResume();
    }, pauseMs);
    // Don't keep the event loop alive solely for the resume probe.
    this.resumeTimer.unref?.();
  }

  private async tryResume(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      if (this.relay.isHealthy()) {
        if (await this.queue.isPaused()) {
          await this.queue.resume();
          this.logger.log(`relay healthy: resumed ${PUBLISH_NIP29_QUEUE}`);
        }
      } else {
        // Still down — check again after another pause window.
        this.armResume();
      }
    } catch (e) {
      this.logger.warn(`failed to resume queue: ${(e as Error)?.message}`);
      this.armResume();
    }
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = undefined;
    }
  }

  /** True when this is the final Bull attempt (no further retry will happen). */
  private isLastAttempt(job: Job<PublishNip29Job>): boolean {
    const attempts = job.opts.attempts ?? this.config.publishMaxRetries + 1;
    return job.attemptsMade + 1 >= attempts;
  }
}

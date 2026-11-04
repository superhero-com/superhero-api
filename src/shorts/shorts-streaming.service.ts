import {
  shortsStorageScope,
  shortsStorageSourceHash,
} from './shorts-runtime-scope';
import {
  Injectable,
  Inject,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ShortsStoreService } from './shorts-store.service';
import { ShortsSafetyService } from './shorts-safety.service';
import { officialContentPolicy } from './shorts-eligibility';
import { ShortsRecordsService } from './shorts-records.service';
import {
  ShortsStreamJobsService,
  StreamClaim,
} from './shorts-stream-jobs.service';
import { ShortsScope } from './shorts-metadata.service';
import { performance } from 'node:perf_hooks';
import { ShortsJobAttempt } from './shorts-job-attempt';
import { discardShortsResponse, readShortsJson } from './shorts-upstream';
import { ShortsDeliveryPackagesService } from './shorts-delivery-packages.service';
import { shortsPlaybackDescriptor } from './shorts-playback-descriptor';
import { ShortsDeliveryAcknowledgementService } from './shorts-delivery-acknowledgement.service';
import { sourceKey } from './hls-protocol/hls-package';
import { HlsPackage, validateSourcePackage } from './hls-protocol/hls-package';
import {
  PlaybackDescriptor,
  validateDescriptor,
} from './hls-protocol/playback-descriptor';

export const SHORTS_STREAM_DISPATCH_MS = Symbol('SHORTS_STREAM_DISPATCH_MS');

// Durable publication outbox: playback preparation must survive an unavailable
// worker/Redis or an API restart. No video bytes pass through this integration.
@Injectable()
export class ShortsStreamingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShortsStreamingService.name);
  private readonly endpoint = process.env.SHORTS_STREAM_INTERNAL_URL?.replace(
    /\/$/,
    '',
  );
  private readonly keyFile = process.env.SHORTS_STREAM_KEY_FILE;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly store: ShortsStoreService,
    private readonly safety: ShortsSafetyService,
    @Optional() private readonly records?: ShortsRecordsService,
    @Optional() private readonly jobs?: ShortsStreamJobsService,
    @Optional()
    @Inject(SHORTS_STREAM_DISPATCH_MS)
    private readonly attemptMs = 30000,
    @Optional()
    private readonly deliveryPackages?: ShortsDeliveryPackagesService,
    @Optional()
    private readonly acknowledgement?: ShortsDeliveryAcknowledgementService,
  ) {
    if (!Number.isSafeInteger(attemptMs) || attemptMs < 1 || attemptMs > 30000)
      throw new Error('Invalid playback dispatch deadline');
    if (!jobs)
      store.db.exec(`CREATE TABLE IF NOT EXISTS shorts_stream_outbox (
      id TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)`);
    if (this.endpoint) {
      const url = new URL(this.endpoint);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' &&
          !(
            local &&
            url.protocol === 'http:' &&
            process.env.NODE_ENV !== 'production'
          ))
      )
        throw new Error(
          'SHORTS_STREAM_INTERNAL_URL requires an HTTPS origin (HTTP only for local development)',
        );
      if (!this.keyFile || !isAbsolute(this.keyFile))
        throw new Error(
          'SHORTS_STREAM_KEY_FILE must be an absolute server-only key path',
        );
    }
  }
  private scope(): ShortsScope {
    const contract = this.records?.chain.state.contract;
    if (!contract) throw new Error('Playback deployment is not initialized');
    return shortsStorageScope(this.records!.chain);
  }
  async enqueue(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid Short ID');
    if (this.jobs) return this.jobs.enqueue(this.scope(), id);
    this.store.db
      .prepare('INSERT OR IGNORE INTO shorts_stream_outbox(id) VALUES(?)')
      .run(id);
  }
  async onApplicationBootstrap() {
    // Hosted readiness and background startup are coordinated with other SQL users.
    if (this.jobs) return;
    await this.initialize();
    this.start();
  }
  async initialize() {
    if (this.jobs) {
      await this.jobs.verify(
        this.scope(),
        shortsStorageSourceHash(this.records!.chain),
      );
    } else {
      const records = this.records
        ? await this.records.all()
        : this.store.load()?.shorts || [];
      for (const short of records)
        if (
          short.publication === 'published' &&
          officialContentPolicy(short, this.safety?.demoAutoApprove).serve
        )
          await this.enqueue(short.id);
    }
  }
  start() {
    if (!this.endpoint || this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.dispatch();
    }, 15000);
    this.timer.unref();
    void this.dispatch();
  }
  dispatch() {
    if (this.stopped || !this.endpoint) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.runDispatch()
      .catch(() =>
        this.logger.warn(
          'Playback dispatch unavailable; pending jobs will retry',
        ),
      )
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async runDispatch() {
    if (this.jobs) {
      for (let i = 0; i < 20 && !this.stopped; i++) {
        const attempt = new ShortsJobAttempt(
          this.shutdown.signal,
          this.attemptMs,
        );
        let claim: StreamClaim | undefined;
        try {
          attempt.check();
          const startedAt = performance.now();
          claim = await this.jobs.claim(this.scope());
          if (!claim) break;
          attempt.lease(startedAt, 30000);
          const status = await this.prepare(
            claim.id,
            claim.cid,
            attempt.signal,
          );
          attempt.check();
          await this.jobs.settle(
            this.scope(),
            claim,
            status === null ? 'denied' : status === 200 ? 'ready' : 'pending',
          );
        } catch {
          if (this.stopped) break;
          if (!claim) throw new Error('Playback claim unavailable');
          if (!attempt.signal.aborted)
            await this.jobs.settle(this.scope(), claim, 'failed');
          this.logger.warn(`Video preparation will retry: ${claim.id}`);
        } finally {
          attempt.close();
        }
      }
      return;
    }
    const rows = this.store.db
      .prepare(
        'SELECT id, attempts FROM shorts_stream_outbox WHERE ready=0 AND next_at<=? ORDER BY next_at LIMIT 20',
      )
      .all(Date.now());
    for (const row of rows) {
      if (this.stopped) break;
      try {
        const status = await this.prepare(String(row.id));
        if (this.stopped) break;
        if (status === null) {
          this.store.db
            .prepare('DELETE FROM shorts_stream_outbox WHERE id=?')
            .run(row.id);
          continue;
        }
        this.store.db
          .prepare(
            'UPDATE shorts_stream_outbox SET ready=?, attempts=0, next_at=? WHERE id=?',
          )
          .run(status === 200 ? 1 : 0, Date.now() + 15000, row.id);
      } catch {
        if (this.stopped) break;
        const attempts = Math.min(Number(row.attempts) + 1, 16);
        this.store.db
          .prepare(
            'UPDATE shorts_stream_outbox SET attempts=?, next_at=? WHERE id=?',
          )
          .run(
            attempts,
            Date.now() + Math.min(300000, 1000 * 2 ** attempts),
            row.id,
          );
        this.logger.warn(`Video preparation will retry: ${row.id}`);
      }
    }
  }
  /** Explicitly adopt the existing canonical package before a delivery switch. */
  async acknowledgeCanonical(id: string, parent: AbortSignal) {
    if (process.env.SHORTS_LEGACY_BACKFILL_ENABLED !== 'true')
      throw new Error('Legacy delivery acknowledgement is disabled');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid Short ID');
    const status = await this.prepare(
      id,
      undefined,
      AbortSignal.any([parent, AbortSignal.timeout(300000)]),
    );
    return {
      id,
      status:
        status === 200 ? 'ready' : status === 202 ? 'preparing' : 'denied',
    };
  }
  private async prepare(id: string, cid?: string, parent?: AbortSignal) {
    const signal = parent
      ? AbortSignal.any([parent, this.shutdown.signal])
      : this.shutdown.signal;
    const eligible = async () => {
      signal.throwIfAborted();
      const short = this.records
        ? await this.records.find(id)
        : this.store.load()?.shorts.find((s) => s.id === id);
      signal.throwIfAborted();
      return (
        short &&
        short.publication === 'published' &&
        (!cid || short.cid === cid) &&
        officialContentPolicy(short, this.safety?.demoAutoApprove).serve &&
        short
      );
    };
    signal.throwIfAborted();
    const key = (
      await readFile(this.keyFile!, { encoding: 'utf8', signal })
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid streaming key');
    const source = await eligible();
    if (this.stopped || !source) return null;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    const response = await fetch(
      `${this.endpoint}/internal/videos/${encodeURIComponent(id)}/prepare`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: requestSignal,
      },
    );
    const durable =
      !!source.original ||
      process.env.SHORTS_LEGACY_BACKFILL_ENABLED === 'true';
    let acknowledgement: any;
    if (response.status === 200 && durable) {
      acknowledgement = await readShortsJson(response, 147456, requestSignal);
    } else discardShortsResponse(response);
    signal.throwIfAborted();
    if (![200, 202].includes(response.status))
      throw new Error('Preparation unavailable');
    // Policy may change during network IO. Shared completion also requires the same generation/lease.
    const current = await eligible();
    if (!current) return null;
    if (response.status === 200 && durable) {
      if (!this.deliveryPackages)
        throw new Error('Durable delivery metadata unavailable');
      const descriptor = shortsPlaybackDescriptor(current, this.scope());
      if (
        acknowledgement?.status !== 'ready' ||
        acknowledgement.sourceKey !== sourceKey(descriptor)
      )
        throw new Error('Playback acknowledgement source changed');
      if (!current.original && !this.acknowledgement)
        throw new Error('Legacy delivery requires physical verification');
      if (this.acknowledgement) {
        await this.acknowledgement.acknowledge(
          current,
          descriptor,
          acknowledgement.prepared,
          async () => {
            const fresh = await eligible();
            if (
              !fresh ||
              sourceKey(shortsPlaybackDescriptor(fresh, this.scope())) !==
                sourceKey(descriptor)
            )
              throw new Error('Delivery publication authority changed');
          },
          signal,
        );
      } else
        await this.deliveryPackages.acknowledge(
          descriptor,
          acknowledgement.prepared,
        );
      signal.throwIfAborted();
    }
    return response.status;
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.shutdown.abort();
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
  /** Explicit generation preparation; saving/selection belongs to the coordinator. */
  async prepareGeneration(
    descriptor: PlaybackDescriptor,
    parent?: AbortSignal,
  ): Promise<HlsPackage | undefined> {
    validateDescriptor(descriptor, descriptor.id);
    const job = descriptor.derivatives?.generation.job;
    if (
      !descriptor.original ||
      !job ||
      job === descriptor.id ||
      !this.endpoint ||
      !this.keyFile ||
      this.stopped
    )
      throw new Error('Generation preparation is unavailable');
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(10000),
      ...(parent ? [parent] : []),
    ]);
    signal.throwIfAborted();
    const key = (
      await readFile(this.keyFile, { encoding: 'utf8', signal })
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid streaming key');
    const response = await fetch(
      `${this.endpoint}/internal/videos/${encodeURIComponent(descriptor.id)}/generations/${encodeURIComponent(job)}/prepare`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        redirect: 'error',
        signal,
      },
    );
    if (response.status === 202) {
      discardShortsResponse(response);
      return undefined;
    }
    if (response.status !== 200) {
      discardShortsResponse(response);
      throw new Error('Generation preparation unavailable');
    }
    const value = await readShortsJson(response, 147456, signal);
    signal.throwIfAborted();
    if (value?.status !== 'ready' || value.sourceKey !== sourceKey(descriptor))
      throw new Error('Generation acknowledgement source changed');
    return validateSourcePackage(descriptor, value.prepared);
  }
}

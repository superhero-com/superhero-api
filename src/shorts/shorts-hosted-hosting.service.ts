import { shortsRuntimeScope } from './shorts-runtime-scope';
import {
  Injectable,
  Inject,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsMediaService } from './shorts-media.service';
import { ShortsRecordsService } from './shorts-records.service';
import { ShortsService } from './shorts.service';
import {
  LifecycleClaim,
  LifecycleResult,
  ShortsLifecycleJobsService,
} from './shorts-lifecycle-jobs.service';
import { officialContentPolicy } from './shorts-eligibility';
import { ShortsJobAttempt } from './shorts-job-attempt';
import { ShortsMediaUnavailableError } from './shorts-media-admission.service';

export const SHORTS_LIFECYCLE_LIMITS = Symbol('SHORTS_LIFECYCLE_LIMITS');
export const LIFECYCLE_LIMITS = {
  attemptMs: 180000,
  leaseMs: 120000,
  renewMs: 30000,
};

/** Hosted recovery uses durable, scoped jobs, not a catalog or pin-inventory sweep. */
@Injectable()
export class ShortsHostedHostingService implements OnModuleDestroy {
  private readonly logger = new Logger(ShortsHostedHostingService.name);
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly chain: ShortsChainService,
    private readonly media: ShortsMediaService,
    private readonly shorts: ShortsService,
    private readonly records: ShortsRecordsService,
    private readonly jobs: ShortsLifecycleJobsService,
    @Optional()
    @Inject(SHORTS_LIFECYCLE_LIMITS)
    private readonly limits = LIFECYCLE_LIMITS,
  ) {
    if (
      Object.values(limits).some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      ) ||
      limits.attemptMs > 180000 ||
      limits.leaseMs > 120000 ||
      limits.renewMs >= limits.leaseMs
    )
      throw new Error('Invalid lifecycle deadlines');
  }
  private scope() {
    return shortsRuntimeScope(this.chain);
  }
  async initialize() {
    if (
      !this.records.shared ||
      this.shorts.demoAutoApprove ||
      !this.shorts.publisher
    )
      throw new Error('Hosted lifecycle requires shared verified publication');
    await this.jobs.verify(this.scope(), this.chain.state.sourceHash!);
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 15000);
    this.timer.unref();
    void this.reconcile();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    // This parent module drains before the imported node-client module closes.
    this.shutdown.abort();
    await this.pending;
  }
  reconcile() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.run()
      .catch(() =>
        this.logger.warn('Lifecycle queue unavailable; saved work will retry.'),
      )
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async run() {
    // A bounded pass returns capacity to other API work. Jobs persist across restarts.
    for (let i = 0; i < 10 && !this.stopped; i++) {
      const attempt = new ShortsJobAttempt(
        this.shutdown.signal,
        this.limits.attemptMs,
      );
      try {
        attempt.check();
        const startedAt = performance.now();
        const claim = await this.jobs.claim(this.scope(), this.limits.leaseMs);
        if (!claim) break;
        attempt.lease(startedAt, this.limits.leaseMs);
        await this.process(claim, attempt);
      } finally {
        attempt.close();
      }
    }
  }
  private async process(claim: LifecycleClaim, attempt: ShortsJobAttempt) {
    let renewing: Promise<void> | undefined;
    const renew = () => {
      attempt.check();
      if (renewing) return renewing;
      const startedAt = performance.now();
      renewing = this.jobs
        .renew(this.scope(), claim, this.limits.leaseMs)
        .then((owned) => {
          if (!owned) throw new Error('Lifecycle lease changed');
          attempt.lease(startedAt, this.limits.leaseMs);
        })
        .catch((error) => {
          attempt.abort();
          throw error;
        })
        .finally(() => {
          renewing = undefined;
        });
      return renewing;
    };
    const pulse = setInterval(() => {
      if (renewing || attempt.signal.aborted) return;
      try {
        void renew().catch(() => undefined);
      } catch {
        attempt.abort();
      }
    }, this.limits.renewMs);
    pulse.unref();
    const live = async () => {
      attempt.check();
      await renew();
      attempt.check();
    };
    try {
      const result = await this.maintain(claim, attempt, live);
      attempt.check();
      await this.jobs.settle(this.scope(), claim, result);
    } catch (error) {
      if (!attempt.signal.aborted && !this.stopped)
        await this.jobs.settle(
          this.scope(),
          claim,
          error instanceof ShortsMediaUnavailableError
            ? 'capacity_wait'
            : 'failed',
        );
      this.logger.warn('Lifecycle work deferred; its saved job will retry.');
    } finally {
      clearInterval(pulse);
      await renewing?.catch(() => undefined);
    }
  }

  private async maintain(
    claim: LifecycleClaim,
    attempt: ShortsJobAttempt,
    live: () => Promise<void>,
  ): Promise<LifecycleResult> {
    await live();
    let short = await this.records.get(claim.id);
    attempt.check();
    if (short.publication === 'withdrawn') {
      return 'retention_pending';
    }
    if (!officialContentPolicy(short).publish) {
      if (
        !short.safety ||
        (short.safety.status === 'error' &&
          short.safety.checkedAt < Date.now() - 60000)
      ) {
        await live();
        await this.shorts.retryInspection(short.id, attempt.signal);
      }
      return 'checked';
    }
    const video = await this.chain.read(
      'get_short',
      [short.id],
      attempt.signal,
    );
    await live();
    short = await this.records.get(short.id);
    attempt.check();
    if (!officialContentPolicy(short).publish) return 'checked';
    if (video && !this.shorts.matchesPublication(short, video))
      throw new Error('Publication identity mismatch');
    if (video?.withdrawn) {
      return 'retention_pending';
    }
    if (short.publication === 'pending') {
      // Never re-upload on every poll or replace a journaled signature.
      const job = await this.shorts.publisher!.status(
        short.id,
        short.creator,
        attempt.signal,
      );
      await live();
      if (!job) {
        if (
          !(await this.shorts.publisher!.capacity(
            short.id,
            short.creator,
            attempt.signal,
          ))
        )
          return 'publication_pending';
        // The creator already committed intent. Storage work belongs to this
        // durable claim, never the HTTP request or the local mutation queue.
        await live();
        await this.media.ensurePinned(short, attempt.signal);
        await live();
        short = await this.records.get(short.id);
        attempt.check();
        if (
          short.publication !== 'pending' ||
          !officialContentPolicy(short).publish
        )
          return 'checked';
        await this.shorts.publisher!.enqueue(
          short.id,
          short.creator,
          attempt.signal,
        );
      } else if (['confirmed', 'reconciled'].includes(job.status))
        await this.shorts.publication(short.creator, short.id, attempt.signal);
      else if (['cancelled', 'reverted'].includes(job.status)) {
        return 'reconciliation_required';
      }
      return 'publication_pending';
    }
    if (short.publication !== 'published') return 'checked'; // A private draft is never auto-published.
    if (!video) {
      // Never create a replacement payment/signature for an uncertain or reorged record.
      return 'reconciliation_required';
    }
    if (!(await this.media.pinned(short.cid, attempt.signal))) {
      await live();
      short = await this.records.get(short.id);
      attempt.check();
      if (officialContentPolicy(short).publish)
        await this.media.pin(short, attempt.signal);
    }
    return 'checked';
  }
}

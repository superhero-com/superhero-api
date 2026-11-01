import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { IngestionJob, IngestionClaim } from './shorts-metadata.service';
import { ShortsWorkerRepositoryService } from './shorts-worker-repository.service';
import { ShortsSourceReaderService } from './shorts-source-reader.service';
import { ShortsPrivateObjectsService } from './shorts-private-objects.service';
import { ShortsEncodingService } from './shorts-encoding.service';
import { ShortsPackageService } from './shorts-package.service';
import {
  ShortsSafetyService,
  ShortsModerationUnavailableError,
} from './shorts-safety.service';
import { ShortsLabelsService } from './shorts-labels.service';
import {
  SHORTS_WORKER_CONFIG,
  ShortsWorkerConfig,
} from './shorts-worker.config';
import { ShortRecord } from './shorts.types';
import {
  ShortsScratchService,
  ScratchCapacityError,
} from './shorts-scratch.service';

@Injectable()
export class ShortsMediaWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShortsMediaWorkerService.name);
  private readonly id = randomUUID();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private pulseTimer?: NodeJS.Timeout;
  private work?: Promise<void>;
  private pulse?: Promise<void>;
  private active?: AbortController;
  private readonly shutdown = new AbortController();
  private diskWaiting = false;
  private retryAt = 0;
  private moderationFailures = 0;
  constructor(
    @Inject(SHORTS_WORKER_CONFIG) private readonly config: ShortsWorkerConfig,
    private readonly metadata: ShortsWorkerRepositoryService,
    private readonly source: ShortsSourceReaderService,
    private readonly objects: ShortsPrivateObjectsService,
    private readonly encoding: ShortsEncodingService,
    private readonly packages: ShortsPackageService,
    private readonly safety: ShortsSafetyService,
    private readonly labels: ShortsLabelsService,
    private readonly scratch: ShortsScratchService,
  ) {}
  async onApplicationBootstrap() {
    if (this.safety.demoAutoApprove)
      throw new Error('Shared workers cannot bypass video checks');
    await this.metadata.verifyRuntime(
      this.config.scope,
      this.config.sourceHash,
    );
    await this.metadata.workerPulse(this.config.scope, this.id);
    this.timer = setInterval(() => {
      void this.drain();
    }, 1000);
    this.pulseTimer = setInterval(() => {
      if (this.pulse || this.stopped) return;
      this.pulse = this.metadata
        .workerPulse(this.config.scope, this.id)
        .catch(() => {
          this.active?.abort();
          this.logger.error('Media worker database heartbeat is unavailable.');
        })
        .finally(() => {
          this.pulse = undefined;
        });
    }, 10000);
    this.pulseTimer.unref();
    void this.drain();
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.shutdown.abort();
    clearInterval(this.timer);
    clearInterval(this.pulseTimer);
    this.active?.abort();
    await this.work;
    await this.pulse;
    await this.metadata
      .workerStop(this.config.scope, this.id)
      .catch(() => undefined);
  }
  drain() {
    if (this.stopped) return Promise.resolve();
    if (this.work) return this.work;
    this.work = this.process()
      .catch(() => {
        this.logger.error(
          'Media queue unavailable; saved jobs remain pending.',
        );
      })
      .finally(() => {
        this.work = undefined;
      });
    return this.work;
  }
  private waitForModeration() {
    if (this.moderationFailures === 0)
      this.logger.warn(
        'Visual inspection unavailable; accepted uploads remain private and queued.',
      );
    this.moderationFailures = Math.min(this.moderationFailures + 1, 5);
    const delay = 5000 * 2 ** (this.moderationFailures - 1);
    this.retryAt =
      performance.now() + Math.min(60000, delay * (1 + Math.random() * 0.2));
  }
  private async process() {
    while (!this.stopped) {
      if (performance.now() < this.retryAt) return;
      try {
        await this.scratch.check(this.shutdown.signal);
        if (this.diskWaiting)
          this.logger.log('Media scratch capacity recovered.');
        this.diskWaiting = false;
      } catch (error) {
        if (!(error instanceof ScratchCapacityError) && !this.stopped)
          throw error;
        if (!this.diskWaiting && !this.stopped)
          this.logger.warn(
            'Media scratch capacity unavailable; accepted jobs remain queued.',
          );
        this.diskWaiting = true;
        return;
      }
      if (this.stopped) return;
      if (!(await this.safety.accepting(this.shutdown.signal))) {
        if (!this.stopped) this.waitForModeration();
        return;
      }
      if (this.stopped) return;
      const leaseStarted = performance.now();
      const job = await this.metadata.claim(
        this.config.scope,
        this.config.leaseMs,
      );
      if (!job || this.stopped) return;
      await this.prepare(job, leaseStarted);
    }
  }
  private async prepare(job: IngestionJob, leaseStarted: number) {
    const claim: IngestionClaim = {
      id: job.id,
      fence: job.fence,
      leaseToken: job.leaseToken,
    };
    const controller = new AbortController();
    this.active = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(600000),
    ]);
    // Start from before the DB request, not the returned wall-clock timestamp.
    // A stalled heartbeat must not keep decoder/IO work alive past its lease.
    const margin = Math.min(1000, Math.floor(this.config.leaseMs / 4));
    let deadline = leaseStarted + this.config.leaseMs - margin;
    let expiry: NodeJS.Timeout;
    const armExpiry = () => {
      clearTimeout(expiry);
      const remaining = deadline - performance.now();
      if (remaining <= 0) controller.abort();
      else {
        expiry = setTimeout(() => controller.abort(), remaining);
        expiry.unref();
      }
    };
    armExpiry();
    let heartbeat: Promise<void>;
    const timer = setInterval(
      () => {
        if (heartbeat || signal.aborted) return;
        const started = performance.now();
        heartbeat = this.metadata
          .heartbeat(this.config.scope, claim, this.config.leaseMs)
          .then((owned) => {
            if (!owned || performance.now() >= deadline || signal.aborted) {
              controller.abort();
              return;
            }
            deadline = started + this.config.leaseMs - margin;
            armExpiry();
          })
          .catch(() => controller.abort())
          .finally(() => {
            heartbeat = undefined;
          });
      },
      Math.max(200, Math.floor(this.config.leaseMs / 3)),
    );
    timer.unref();
    try {
      signal.throwIfAborted();
      const original = await this.source.read(this.config.scope, job, signal);
      // Inspect before encoding so a busy scanner does not repeatedly spend
      // decoder resources. Only current live claims can defer the saved source.
      const safety = await this.safety.scan(original, signal, true);
      signal.throwIfAborted();
      if (this.moderationFailures)
        this.logger.log('Visual inspection recovered.');
      this.moderationFailures = 0;
      const prepared = await this.encoding.encode(
        original,
        job.input.title.trim(),
        job.input.topic,
        job.input.details,
        signal,
      );
      signal.throwIfAborted();
      const cid = await this.packages.cid(prepared.files, signal);
      const files = prepared.files.map((file) => ({
        name: file.name,
        bytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
      }));
      const refs: NonNullable<ShortRecord['privateMedia']>['files'] = {};
      for (const file of prepared.files) {
        signal.throwIfAborted();
        refs[file.name] = await this.objects.put(
          this.config.scope,
          job.id,
          `attempt/${job.fence}/${file.name.replaceAll('.', '-')}`,
          file.data,
          signal,
        );
      }
      const classification = await this.labels.classify(
        {
          title: job.input.title.trim(),
          topic: job.input.topic,
          description: job.input.details.description as string,
          captions: job.input.details.captions as string,
        },
        signal,
      );
      signal.throwIfAborted();
      const record: ShortRecord = {
        id: job.id,
        creator: job.creator,
        title: job.input.title.trim(),
        topic: job.input.topic,
        cid,
        bytes: prepared.bytes,
        duration: prepared.duration,
        files,
        safety,
        classification,
        createdAt: Date.now(),
        description: String(job.input.details.description || ''),
        language: String(job.input.details.language || 'und'),
        synthetic: job.input.details.synthetic === true,
        sponsored: job.input.details.sponsored === true,
        captions: !!job.input.details.captions,
        moderation: safety?.status === 'blocked' ? 'rejected' : 'pending',
        reviewReason: safety?.reason,
        reports: 0,
        views: [],
        privateMedia: {
          version: 1,
          fence: job.fence,
          source: job.input,
          files: refs,
        },
      };
      // Outputs can outlive a dead worker, but only the current fenced claim
      // may attach them to a content record. No publish/pin/sign action exists here.
      await this.metadata.complete(this.config.scope, claim, record);
    } catch (error) {
      if (
        (error instanceof ScratchCapacityError ||
          error instanceof ShortsModerationUnavailableError) &&
        !this.stopped &&
        !controller.signal.aborted
      ) {
        // Only the current live claim can refund this infrastructure attempt.
        // An uncertain response may already have deferred it; never call fail afterwards.
        if (error instanceof ShortsModerationUnavailableError) {
          this.waitForModeration();
        } else {
          if (!this.diskWaiting)
            this.logger.warn(
              'Media scratch capacity unavailable; preparation deferred.',
            );
          this.diskWaiting = true;
          this.retryAt = performance.now() + 5000;
        }
        await this.metadata
          .defer(this.config.scope, claim)
          .catch(() => undefined);
        return;
      }
      // Lease uncertainty is recoverable, not a verdict on the creator's video.
      // Leave the accepted job for expiry/reclaim instead of making it terminal.
      if (!this.stopped && !controller.signal.aborted)
        await this.metadata
          .fail(this.config.scope, claim)
          .catch(() => undefined);
    } finally {
      clearInterval(timer);
      clearTimeout(expiry);
      await heartbeat;
      if (this.active === controller) this.active = undefined;
    }
  }
}

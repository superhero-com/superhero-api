import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SHORTS_RATE_CONFIG, ShortsRateConfig } from './shorts-rate.config';
import { ShortsChainService } from './shorts-chain.service';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ShortsAdmissionBusyError,
  ShortsAdmissionLimits,
  ShortsTransferAdmissionService,
} from './shorts-transfer-admission.service';

export const SHORTS_MEDIA_ADMISSION_LIMITS = Symbol(
  'SHORTS_MEDIA_ADMISSION_LIMITS',
);

export class ShortsMediaUnavailableError extends ServiceUnavailableException {
  constructor() {
    super(
      'Video processing is busy or temporarily unavailable. Please retry shortly.',
    );
  }
}

/** Separate shared budget for hosted preview, scan and recovery transfers. */
@Injectable()
export class ShortsMediaAdmissionService extends ShortsTransferAdmissionService {
  private readonly waitingShutdown = new AbortController();
  private waiting = 0;
  constructor(
    @Inject(SHORTS_RATE_CONFIG) config: ShortsRateConfig,
    chain: ShortsChainService,
    @Optional()
    @Inject(SHORTS_MEDIA_ADMISSION_LIMITS)
    limits?: ShortsAdmissionLimits,
  ) {
    super(
      config,
      chain,
      limits || {
        capacity: Number(process.env.SHORTS_SHARED_CONCURRENT_MEDIA ?? 2),
        leaseMs: 30000,
        renewMs: 10000,
      },
      'media',
    );
  }
  override async acquire(actor: string, parent?: AbortSignal) {
    // Interactive callers remain fail-fast. Delivery verification can wait for
    // contention, but never for an invalid policy/scope or unavailable Redis.
    if (!parent) {
      try {
        return await super.acquire(actor);
      } catch {
        throw new ShortsMediaUnavailableError();
      }
    }
    const signal = AbortSignal.any([parent, this.waitingShutdown.signal]);
    signal.throwIfAborted();
    if (this.waiting >= 32) throw new ShortsMediaUnavailableError();
    this.waiting++;
    const deadline = performance.now() + 5000;
    try {
      while (true) {
        signal.throwIfAborted();
        // Reserve the existing one-second Redis command timeout. Do not begin
        // another command once it could overrun this bounded wait.
        if (performance.now() + 1000 > deadline)
          throw new ShortsMediaUnavailableError();
        try {
          const reservation = await super.acquire(actor);
          if (signal.aborted || performance.now() > deadline) {
            await reservation.release();
            signal.throwIfAborted();
            throw new ShortsMediaUnavailableError();
          }
          return reservation;
        } catch (error) {
          signal.throwIfAborted();
          if (
            !(error instanceof ShortsAdmissionBusyError) ||
            performance.now() + 1250 >= deadline
          )
            throw new ShortsMediaUnavailableError();
          await delay(250, undefined, { signal });
        }
      }
    } finally {
      this.waiting--;
    }
  }
  override async beforeApplicationShutdown() {
    this.waitingShutdown.abort(new ShortsMediaUnavailableError());
    await super.beforeApplicationShutdown();
  }
}

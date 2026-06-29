import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bull';
import tgrConfig, { isRelayConfigured } from '../config/tgr.config';
import { prefixQueue, TGR_QUEUE_NAMES } from '../config/queue-prefix';
import { ReconciliationService } from '../services/reconciliation.service';
import { ReorgEvictionService } from '../services/reorg-eviction.service';

/**
 * Resolved queue name (`worker:reconcile-membership`) — registered + consumed
 * WORKER-side (canonical literal from Task 01's `prefixQueue`/`TGR_QUEUE_NAMES`).
 * Distinct from Task 03's `main:reconcile-balance` (AEX9 balances): the old single
 * `reconcile` queue is split so a relay-outage backlog of membership reconciles
 * cannot starve the indexer's balance sweep (§9).
 */
export const RECONCILE_MEMBERSHIP_QUEUE = prefixQueue(
  TGR_QUEUE_NAMES.RECONCILE_MEMBERSHIP,
  'worker',
);

/**
 * Bull job names on `worker:reconcile-membership`.
 *
 * - {@link RECONCILE_MEMBERSHIP_JOB}: the rotating read-back driver (one job = one
 *   batch of rooms; {@link ReconciliationService.reconcileBatch}). Repeats every
 *   `TG_RECONCILE_INTERVAL` (default 10m).
 * - {@link REORG_FLUSH_JOB}: the reorg-buffer flush
 *   ({@link ReorgEvictionService.flushDueEvictions}) — publishes `9001` for
 *   evictions whose `held_until_height` has passed. Repeats on the same interval
 *   (the buffer depth, not the interval, sets the eviction delay).
 */
export const RECONCILE_MEMBERSHIP_JOB = 'reconcile-membership-batch';
export const REORG_FLUSH_JOB = 'reorg-eviction-flush';

/**
 * Consumer for `worker:reconcile-membership` (Task 11).
 *
 * Owns two repeatable jobs (both registered on boot, relay-gated):
 *  - the rotating membership read-back/diff/self-heal (Task §A), and
 *  - the reorg-eviction flush (Task §B.7).
 *
 * Relay-gating (worker mode removed — see `deworker-plan.md`): both jobs publish
 * to / read from the relay, so we schedule NOTHING and short-circuit each
 * `@Process` handler unless a relay is configured (`isRelayConfigured`). With no
 * relay the boot smoke instantiates the processor but nothing is enqueued or run.
 */
@Injectable()
@Processor(RECONCILE_MEMBERSHIP_QUEUE)
export class ReconcileProcessor implements OnModuleInit {
  private readonly logger = new Logger(ReconcileProcessor.name);

  constructor(
    @InjectQueue(RECONCILE_MEMBERSHIP_QUEUE)
    private readonly queue: Queue,
    private readonly reconciliation: ReconciliationService,
    private readonly reorgEviction: ReorgEvictionService,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /**
   * Schedule both repeatable jobs on boot — relay-gated. Bull dedupes by job id +
   * repeat-opts so re-registering on every restart is safe. Interval =
   * `TG_RECONCILE_INTERVAL` (default 10m). With no relay configured this is a no-op
   * (nothing to read back / publish).
   */
  async onModuleInit(): Promise<void> {
    if (!isRelayConfigured(this.config)) {
      return;
    }
    const everyMs = Math.max(1, this.config.reconcileIntervalSec) * 1000;
    try {
      await this.queue.add(
        RECONCILE_MEMBERSHIP_JOB,
        {},
        {
          jobId: RECONCILE_MEMBERSHIP_JOB,
          repeat: { every: everyMs },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      await this.queue.add(
        REORG_FLUSH_JOB,
        {},
        {
          jobId: REORG_FLUSH_JOB,
          repeat: { every: everyMs },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log(
        `scheduled reconcile-membership + reorg-flush every ${everyMs}ms on ` +
          `'${RECONCILE_MEMBERSHIP_QUEUE}'`,
      );
    } catch (error: any) {
      this.logger.error(
        `failed to schedule reconcile-membership jobs: ${error?.message ?? error}`,
      );
    }
  }

  /** One rotating reconcile batch (read-back + diff + corrective enqueue). */
  @Process({ name: RECONCILE_MEMBERSHIP_JOB, concurrency: 1 })
  async reconcile(): Promise<void> {
    if (!isRelayConfigured(this.config)) {
      return;
    }
    const result = await this.reconciliation.reconcileBatch();
    this.logger.debug(
      `[reconcile] rooms=${result.roomsScanned} +${result.added} -${result.removed} ` +
        `cursor=${result.nextCursor ?? '<wrapped>'}`,
    );
  }

  /** Flush reorg-buffered evictions whose hold has passed. */
  @Process({ name: REORG_FLUSH_JOB, concurrency: 1 })
  async flush(): Promise<void> {
    if (!isRelayConfigured(this.config)) {
      return;
    }
    const { published, cancelled } =
      await this.reorgEviction.flushDueEvictions();
    if (published > 0 || cancelled > 0) {
      this.logger.debug(
        `[reorg-flush] published=${published} cancelled=${cancelled}`,
      );
    }
  }
}

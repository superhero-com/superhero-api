import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Inject, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Job, Queue } from 'bull';
import tgrConfig from '../config/tgr.config';
import { RoomBackfillService } from '../services/room-backfill.service';
import {
  BACKFILL_KICKOFF_JOB,
  BACKFILL_STALE_SWEEP_JOB,
  ROOM_BACKFILL_QUEUE,
} from './room-backfill.constants';

/** Payload for the kickoff/driver job: the keyset cursor to process after. */
export interface BackfillKickoffJob {
  /** Process tokens with `sale_address > afterSaleAddress` (omit for first page). */
  afterSaleAddress?: string;
}

/**
 * Consumer for `worker:room-backfill` (Task 09) — WORKER PROCESS ONLY.
 *
 * Two job types:
 *  - {@link BACKFILL_KICKOFF_JOB}: process one page of the working set via
 *    {@link RoomBackfillService.processPage}; if the page was full (more may
 *    remain) re-enqueue the next page so the sweep walks the whole registry
 *    without holding a single long-lived job. Concurrency is 1 so pages are
 *    processed serially (the publish fan-out itself is rate-limited by the Task 07
 *    `worker:publish-nip29` token-bucket / limiter — this queue must NOT add a
 *    second parallel pressure source on the relay).
 *  - {@link BACKFILL_STALE_SWEEP_JOB}: re-publish `pending` rooms with no ACK for
 *    > 24h (relay idempotency makes the duplicate publish safe).
 *
 * This queue runs under the `worker:` prefix (Task 01) so it can never steal the
 * `main:` indexer's jobs (§9). Worst case driven from here: ~54k tokens × 2
 * publishes ≈ 108k publishes — load-test before cutover (§6.2 / Task 16).
 */
@Processor(ROOM_BACKFILL_QUEUE)
export class RoomBackfillProcessor {
  private readonly logger = new Logger(RoomBackfillProcessor.name);

  constructor(
    private readonly backfill: RoomBackfillService,
    @InjectQueue(ROOM_BACKFILL_QUEUE)
    private readonly queue: Queue,
    @Inject(tgrConfig.KEY)
    private readonly config: ConfigType<typeof tgrConfig>,
  ) {}

  /** Drive one page, then chain the next if the page was full. */
  @Process({ name: BACKFILL_KICKOFF_JOB, concurrency: 1 })
  async kickoff(job: Job<BackfillKickoffJob>): Promise<void> {
    const after = job.data?.afterSaleAddress;
    const result = await this.backfill.processPage(after);
    this.logger.log(
      `[room-backfill] page after=${after ?? '<start>'}: ` +
        `requested=${result.requested} hasMore=${result.hasMore} ` +
        `nextCursor=${result.nextCursor ?? '<end>'}`,
    );

    if (result.hasMore && result.nextCursor) {
      // Chain the next page after a pacing delay so back-to-back pages don't
      // sustain pressure on the DB pool / relay (`backfillPageDelayMs`, default
      // 1s; 0 chains immediately). A fresh jobId per page keeps the fixed-id
      // kickoff collapse (in startBackfill) for the FIRST page only; subsequent
      // pages are distinct so they are not collapsed onto a stale completed job.
      await this.queue.add(
        BACKFILL_KICKOFF_JOB,
        { afterSaleAddress: result.nextCursor },
        {
          delay: this.config.backfillPageDelayMs,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } else {
      this.logger.log('[room-backfill] working set drained — kickoff complete');
    }
  }

  /** Re-publish stale (>24h, no ACK) pending rooms. */
  @Process({ name: BACKFILL_STALE_SWEEP_JOB, concurrency: 1 })
  async staleSweep(): Promise<void> {
    const republished = await this.backfill.sweepStalePending();
    this.logger.debug(
      `[room-backfill] stale sweep re-published ${republished} room(s)`,
    );
  }
}

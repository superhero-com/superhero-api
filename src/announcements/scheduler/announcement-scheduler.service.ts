import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnnouncementService } from '../services/announcement.service';
import { AnnouncementDispatchService } from '../services/announcement-dispatch.service';
import announcementsConfig from '../announcements.config';

/**
 * Bound on the number of pending-flag re-iterations in a single tick. Caps a
 * runaway loop if wake signals arrive faster than each drain completes — the
 * next cron tick (or wake) picks up the rest. Without this, a sustained wake
 * storm could keep `running=true` indefinitely and block all other @Cron jobs
 * on the same Nest ScheduleModule.
 */
const MAX_DRAIN_REENTRIES = 100;

/**
 * Per-row attempt cap, persisted on the announcements row itself as
 * `attempt_count`. `releaseClaim` increments it; once the count reaches the
 * cap on a release, the scheduler stamps the row poisoned (markPoisoned →
 * processed_at + error) instead of releasing it again. Persisting the counter
 * survives ticks, replicas and restarts, so a deterministically failing row
 * gets escaped even when crashes are slow / cross multiple ticks.
 */
const MAX_DISPATCH_ATTEMPTS_PER_ROW = 3;

/**
 * Drains all due announcements each tick. Wake signals (Redis pub/sub from the
 * admin) and the cron both flow through `tick()`. Re-entrance is coalesced: a
 * wake that arrives while a drain is in flight sets `pending` and triggers one
 * follow-up drain after the current one finishes, so an immediate-dispatch
 * signal is never lost just because a long fan-out is in progress.
 *
 * Each tick first runs `releaseStuck()` to recover rows whose `claimed_at` is
 * older than the configured threshold (crash recovery), then drains the queue
 * via `claimNextDue` → `dispatch.run` → `markCompleted`. If `dispatch.run`
 * throws unexpectedly, the row's claim is released back to NULL (NOT stamped
 * completed with zero counters) so the next tick can re-run it; this preserves
 * the crash-recovery path that `releaseStuck` provides.
 */
@Injectable()
export class AnnouncementSchedulerService {
  private readonly logger = new Logger(AnnouncementSchedulerService.name);
  private running = false;
  private pending = false;

  constructor(
    private readonly announcements: AnnouncementService,
    private readonly dispatch: AnnouncementDispatchService,
    @Inject(announcementsConfig.KEY)
    private readonly config: ConfigType<typeof announcementsConfig>,
  ) {}

  @Cron(process.env.ANNOUNCEMENTS_CRON || CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    if (this.running) {
      // Wake signals during a running drain mark a follow-up rather than being
      // dropped; the loop below re-ticks once until no new pending arrives.
      this.pending = true;
      return;
    }

    this.running = true;
    let reentries = 0;
    try {
      do {
        this.pending = false;
        try {
          await this.announcements.releaseStuck(this.config.staleClaimMs);
        } catch (error) {
          this.logger.error('releaseStuck failed', error as Error);
        }
        let claimed = await this.announcements.claimNextDue();
        while (claimed) {
          const claimedId = claimed.id;
          const claimToken = claimed.claim_token;
          try {
            await this.dispatch.run(claimed);
          } catch (error) {
            this.logger.error(
              `Dispatch crashed for announcement ${claimedId}`,
              error as Error,
            );

            if (!claimToken) {
              // Without the token we can't safely release-and-increment; the
              // row may have been released by a peer's releaseStuck. Skip;
              // releaseStuck on next tick will re-pick it up if needed.
              this.logger.error(
                `Cannot release claim for announcement ${claimedId}: no claim_token on the loaded row`,
              );
              claimed = await this.announcements.claimNextDue();
              continue;
            }

            try {
              const attempts = await this.announcements.releaseClaim(
                claimedId,
                claimToken,
              );
              if (attempts >= MAX_DISPATCH_ATTEMPTS_PER_ROW) {
                // The persisted attempt counter just crossed the cap — take
                // the row out of contention permanently. markPoisoned is
                // unconditional (no claim_token guard) because we want it to
                // succeed even if a peer is now the nominal owner.
                this.logger.warn(
                  `Announcement ${claimedId} hit attempt cap (${attempts}/${MAX_DISPATCH_ATTEMPTS_PER_ROW}); marking poisoned`,
                );
                try {
                  await this.announcements.markPoisoned(
                    claimedId,
                    `dispatch crashed ${attempts}× across ticks: ${(error as Error).message}`,
                  );
                } catch (markError) {
                  this.logger.error(
                    `Failed to mark poison announcement ${claimedId} completed`,
                    markError as Error,
                  );
                }
              }
            } catch (releaseError) {
              this.logger.error(
                `Failed to release claim for announcement ${claimedId}`,
                releaseError as Error,
              );
            }
          }
          claimed = await this.announcements.claimNextDue();
        }

        reentries += 1;
        if (this.pending && reentries >= MAX_DRAIN_REENTRIES) {
          this.logger.warn(
            `Drain re-entry cap (${MAX_DRAIN_REENTRIES}) hit; deferring remaining work to next tick`,
          );
          break;
        }
      } while (this.pending);
    } catch (error) {
      this.logger.error('Announcement tick failed', error as Error);
    } finally {
      this.running = false;
    }
  }
}

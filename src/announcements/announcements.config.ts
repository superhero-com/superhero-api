import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';

export const ANNOUNCEMENTS_CONFIG = 'announcements';

const DEFAULT_FANOUT_BATCH = 500;
const configLogger = new Logger('AnnouncementsConfig');

function parseFanoutBatch(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_FANOUT_BATCH;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    configLogger.warn(
      `ANNOUNCEMENTS_FANOUT_BATCH="${raw}" is not a positive integer; falling back to ${DEFAULT_FANOUT_BATCH}`,
    );
    return DEFAULT_FANOUT_BATCH;
  }
  return parsed;
}

/**
 * Env-backed config for the announcements scheduler. Consumed via
 * `@Inject(announcementsConfig.KEY)` with `ConfigType<typeof announcementsConfig>`.
 * The cron cadence is read directly from `ANNOUNCEMENTS_CRON` at the @Cron decorator
 * (it must be a literal at class-decoration time), defaulting to every 5 minutes.
 */
export default registerAs(ANNOUNCEMENTS_CONFIG, () => ({
  /** Master switch for the scheduler. Off by default; endpoints stay up regardless. */
  enabled: true,

  /**
   * Addresses dispatched per fan-out batch. Refuses non-positive values so a
   * misconfigured env var can't deadlock the scheduler in an infinite loop.
   */
  fanoutBatch: parseFanoutBatch(process.env.ANNOUNCEMENTS_FANOUT_BATCH),

  /**
   * How long a `claimed_at`-stamped row can stay un-completed before the
   * scheduler considers it crashed and releases it back to the pending pool.
   */
  staleClaimMs: 5 * 60 * 1000,
}));

import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';

export const NOTIFICATIONS_CONFIG = 'notifications';

const configLogger = new Logger('NotificationsConfig');

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  varName: string,
): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    configLogger.warn(
      `${varName}="${raw}" is not a positive integer; falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Centralized, env-backed configuration for the notification module.
 * Consumed via `@Inject(notificationsConfig.KEY)` with `ConfigType<typeof notificationsConfig>`.
 */
export default registerAs(NOTIFICATIONS_CONFIG, () => ({
  /** Master kill-switch. When false the live trigger no-ops; endpoints stay up. */
  enabled: process.env.NOTIFICATIONS_ENABLED === 'true',

  /** Optional Expo access token (raises limits + enables enhanced security). */
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || undefined,

  /**
   * Expo accepts at most 100 messages per push request. Guarded so a malformed
   * env var (e.g. "auto", trailing garbage) doesn't silently produce NaN and
   * collapse the chunk loop to zero iterations, losing every push notification.
   */
  expoPushBatchSize: Math.min(
    parsePositiveInt(
      process.env.EXPO_PUSH_BATCH_SIZE,
      100,
      'EXPO_PUSH_BATCH_SIZE',
    ),
    100,
  ),

  /** Delay before polling delivery receipts (~15 min recommended by Expo). */
  receiptDelayMs: parsePositiveInt(
    process.env.EXPO_RECEIPT_DELAY_MS,
    900_000,
    'EXPO_RECEIPT_DELAY_MS',
  ),

  /** Device-link challenge lifetime. */
  challengeTtlMs: parsePositiveInt(
    process.env.NOTIF_CHALLENGE_TTL_MS,
    300_000,
    'NOTIF_CHALLENGE_TTL_MS',
  ),

  /**
   * Hard cap on un-consumed un-expired challenges per address. Combined with the
   * RateLimitGuard, this caps an attacker's ability to flood the table from a
   * single address. Env-tunable so ops can dial down during an abuse event
   * without a deploy.
   */
  challengeMaxPendingPerAddress: parsePositiveInt(
    process.env.NOTIF_CHALLENGE_MAX_PENDING_PER_ADDRESS,
    5,
    'NOTIF_CHALLENGE_MAX_PENDING_PER_ADDRESS',
  ),

  /** Idempotency window for (notification-type, dedup-key). */
  dedupTtlMs: parsePositiveInt(
    process.env.NOTIF_DEDUP_TTL_MS,
    3_600_000,
    'NOTIF_DEDUP_TTL_MS',
  ),

  /** Anti-dust floor (aettos). Transfers below this never notify. Default 0 = off. */
  minAmountAettos: BigInt(process.env.NOTIF_MIN_AMOUNT_AETTOS || '0'),

  /** Stale-device cleanup horizon (days since last_seen_at). */
  staleDeviceDays: parsePositiveInt(
    process.env.NOTIF_STALE_DEVICE_DAYS,
    90,
    'NOTIF_STALE_DEVICE_DAYS',
  ),

  /** Wall-clock timeout for any single Expo HTTP call (push or receipt poll). */
  expoFetchTimeoutMs: parsePositiveInt(
    process.env.EXPO_FETCH_TIMEOUT_MS,
    15_000,
    'EXPO_FETCH_TIMEOUT_MS',
  ),

  /**
   * Per-recipient rate cap on post-comment notifications. A coordinated comment
   * storm against a popular author would otherwise produce one push per spam
   * comment (each distinct txHash defeats per-tx dedup). The cap is a fixed
   * rolling window via Redis INCR+EXPIRE.
   */
  postCommentRateCap: parsePositiveInt(
    process.env.NOTIF_POST_COMMENT_RATE_CAP,
    20,
    'NOTIF_POST_COMMENT_RATE_CAP',
  ),
  postCommentRateWindowSec: parsePositiveInt(
    process.env.NOTIF_POST_COMMENT_RATE_WINDOW_SEC,
    3600,
    'NOTIF_POST_COMMENT_RATE_WINDOW_SEC',
  ),
}));

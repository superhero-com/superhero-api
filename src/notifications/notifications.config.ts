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
  enabled: true,

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

  /**
   * Lifetime of a web-feed bearer session, minted from a single æternity
   * signature (the SIWE-style bootstrap) and used to authorize feed reads,
   * mark-read, and the socket handshake. Default 7 days = re-sign weekly.
   * Lives in Redis (revocable), so shortening it is a safe ops dial.
   */
  feedSessionTtlMs: parsePositiveInt(
    process.env.NOTIF_FEED_SESSION_TTL_MS,
    7 * 24 * 60 * 60 * 1000,
    'NOTIF_FEED_SESSION_TTL_MS',
  ),

  /**
   * Retention horizon for the per-recipient web feed. A read notification older
   * than this is pruned by the cleanup cron — the feed is a convenience cache
   * over chain-derived events, not a system of record, so we don't hoard a
   * central activity log indefinitely.
   */
  feedRetentionDays: parsePositiveInt(
    process.env.NOTIF_FEED_RETENTION_DAYS,
    90,
    'NOTIF_FEED_RETENTION_DAYS',
  ),

  /**
   * Hard cap on stored feed rows per address. The cleanup cron trims the oldest
   * rows beyond this count so a high-traffic address can't grow unbounded.
   */
  feedMaxRowsPerAddress: parsePositiveInt(
    process.env.NOTIF_FEED_MAX_ROWS_PER_ADDRESS,
    500,
    'NOTIF_FEED_MAX_ROWS_PER_ADDRESS',
  ),

  /**
   * Max rows the age-based retention sweep deletes in a single tick. Bounds
   * the worst case (a first sweep after a long cron outage, or a
   * `NOTIF_FEED_RETENTION_DAYS` cut that instantly ages out months of
   * backlog) to one bounded statement instead of one unbounded DELETE holding
   * row locks / generating a WAL burst for however many rows have aged out
   * since the last successful tick. A backlog larger than this is simply
   * finished off over the next few hourly ticks.
   */
  feedRetentionDeleteBatchSize: parsePositiveInt(
    process.env.NOTIF_FEED_RETENTION_DELETE_BATCH_SIZE,
    10_000,
    'NOTIF_FEED_RETENTION_DELETE_BATCH_SIZE',
  ),

  /**
   * Max page size a single feed-list request may return. Guards against a
   * client asking for an unbounded page.
   */
  feedMaxPageSize: parsePositiveInt(
    process.env.NOTIF_FEED_MAX_PAGE_SIZE,
    50,
    'NOTIF_FEED_MAX_PAGE_SIZE',
  ),

  /**
   * Max concurrent socket connections accepted per address (in-memory cap;
   * single-container deploy). Stops one address from exhausting sockets.
   */
  socketMaxConnsPerAddress: parsePositiveInt(
    process.env.NOTIF_SOCKET_MAX_CONNS_PER_ADDRESS,
    10,
    'NOTIF_SOCKET_MAX_CONNS_PER_ADDRESS',
  ),

  /**
   * Max socket-handshake ATTEMPTS accepted per source IP per rolling minute
   * (in-memory; single-container deploy), checked before any session lookup.
   * `socketMaxConnsPerAddress` only bounds sockets that resolve to a real
   * address — a flood of junk-token handshakes never reaches that counter, so
   * this is the only thing bounding the cost (one Redis GET per attempt) of an
   * anonymous connect flood.
   */
  socketMaxHandshakesPerIpPerMinute: parsePositiveInt(
    process.env.NOTIF_SOCKET_MAX_HANDSHAKES_PER_IP_PER_MIN,
    30,
    'NOTIF_SOCKET_MAX_HANDSHAKES_PER_IP_PER_MIN',
  ),

  /**
   * VAPID keypair + subject for browser Web Push (the `web-push` channel).
   * Generate with `npx web-push generate-vapid-keys`. When the public/private
   * pair is absent the channel logs once and no-ops — the feature stays dark
   * until configured, mirroring how `expoAccessToken` gates enhanced Expo.
   * `vapidSubject` must be a `mailto:` or `https:` URL identifying the sender.
   */
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || undefined,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || undefined,
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@superhero.com',

  /** Wall-clock timeout for a single Web Push HTTP send. */
  webPushFetchTimeoutMs: parsePositiveInt(
    process.env.WEB_PUSH_FETCH_TIMEOUT_MS,
    10_000,
    'WEB_PUSH_FETCH_TIMEOUT_MS',
  ),
}));

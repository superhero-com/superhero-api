import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';
import { QUEUE_PREFIX } from './queue-prefix';

export const TGR_CONFIG = 'tokenGatedRooms';

const configLogger = new Logger('TgrConfig');

/**
 * The relay-enable switch (replaces the old `main`/`worker`/`combined` process
 * modes — see `deworker-plan.md` DW2). TGR now runs in ONE always-on process; the
 * relay-actuator duties (writer/subscriber + their Bull consumers + the
 * backfill/reconcile/membership-sync crons) self-enable iff a relay is configured
 * (`TG_RELAY_URL` + `TG_BOT_NSEC` both non-blank). When unconfigured the process
 * still indexes room-state/balances/eligibility and serves the read API — it just
 * publishes nothing — so a missing relay var can never crash the public API. A var
 * that is present but INVALID (e.g. a malformed `TG_BOT_NSEC`) is likewise
 * non-fatal: the relay actuators decode the nsec defensively and stay dormant (with
 * a loud error log) instead of throwing at boot.
 *
 * Accepts either the typed config (`ConfigType<typeof tgrConfig>`, what services
 * inject) or a raw env-like map (`{ TG_RELAY_URL, TG_BOT_NSEC }`) so it is callable
 * from both runtime providers and pure unit tests.
 */
export function isRelayConfigured(
  source:
    | { nostrRelayUrl?: string | null; nostrBotNsec?: string | null }
    | Record<string, string | undefined>,
): boolean {
  const url =
    (source as { nostrRelayUrl?: string | null }).nostrRelayUrl ??
    (source as Record<string, string | undefined>).TG_RELAY_URL;
  const nsec =
    (source as { nostrBotNsec?: string | null }).nostrBotNsec ??
    (source as Record<string, string | undefined>).TG_BOT_NSEC;
  return (
    typeof url === 'string' &&
    url.trim() !== '' &&
    typeof nsec === 'string' &&
    nsec.trim() !== ''
  );
}

/**
 * Numeric env parser mirroring `configs/database.ts#parseNumber`: blank/garbage
 * or out-of-range values fall back to the default instead of poisoning a knob.
 */
function parseNumber(
  value: string | undefined,
  defaultValue: number,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  if (options.integer && !Number.isInteger(parsed)) {
    return defaultValue;
  }
  if (options.min !== undefined && parsed < options.min) {
    return defaultValue;
  }
  if (options.max !== undefined && parsed > options.max) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a duration like `5m`, `10m`, `30s`, or a bare number (seconds) into
 * **seconds**. Garbage falls back to the default (also in seconds). Used for the
 * `*_INTERVAL` / `*_REFRESH` / backoff-cap knobs expressed as `5m` in §18.
 */
function parseDurationSeconds(
  value: string | undefined,
  defaultSeconds: number,
): number {
  if (value === undefined || value.trim() === '') {
    return defaultSeconds;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) {
    configLogger.warn(
      `Duration "${value}" is not parseable; falling back to ${defaultSeconds}s`,
    );
    return defaultSeconds;
  }
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const factor =
    unit === 'h' ? 3600 : unit === 'm' ? 60 : unit === 'ms' ? 0.001 : 1;
  const seconds = amount * factor;
  if (!Number.isFinite(seconds) || seconds < 0) {
    return defaultSeconds;
  }
  return seconds;
}

/** Parse a comma-separated list into a trimmed, non-empty array. */
function parseList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  return value.trim().toLowerCase() === 'true';
}

/**
 * Env-backed config for the token-gated-rooms feature (plan §18). Consumed via
 * `@Inject(tgrConfig.KEY)` with `ConfigType<typeof tgrConfig>`. Defaults are
 * verbatim from §18; numeric knobs reject garbage and fall back to default.
 *
 * Duration-shaped knobs (`*Sec`, `reconcileIntervalSec`, `communityTokenRefreshSec`,
 * `publishBackoffCapMs`) are normalized to a numeric unit so consumers don't
 * re-parse `5m`/`10m` strings.
 */
export default registerAs(TGR_CONFIG, () => ({
  /** groups_relay ws:// — enables the relay duties when set (D7/DW2). */
  nostrRelayUrl: process.env.TG_RELAY_URL,

  /** Secret. Enables the relay duties when set. Must be the relay admin (D7). */
  nostrBotNsec: process.env.TG_BOT_NSEC,

  /** Comma-separated nostr pubkeys (npub/hex) seeded as admins in every room (D9). */
  nostrRoomAdmins: parseList(process.env.TG_ROOM_ADMINS),

  /** `Account.links` provider key resolved to a Nostr pubkey (§6.6). */
  nostrLinkProvider: process.env.NOSTR_LINK_PROVIDER || 'nostr',

  /** Group-id prefix (only used if a derived id is chosen; D3 default uses sale_address). */
  nostrGroupIdPrefix: process.env.TG_GROUP_ID_PREFIX || 'sh',

  /**
   * Rooms per backfill batch (eager sweep + the to-completion `run()` /
   * stale-pending sweep). HARD-CAPPED at 100 so a single iteration can never open
   * a large burst of DB work and starve the shared Postgres pool — an override
   * above 100 falls back to the default rather than being honored.
   */
  backfillBatchSize: parseNumber(process.env.TG_BACKFILL_BATCH_SIZE, 100, {
    integer: true,
    min: 1,
    max: 100,
  }),

  /**
   * Delay (ms) the eager backfill waits between pages before enqueueing the next
   * one (`RoomBackfillProcessor` chains pages via a delayed job). Paces the sweep
   * so back-to-back pages don't sustain pressure on the DB pool / relay; `0`
   * chains immediately (legacy behaviour). Default 1s.
   */
  backfillPageDelayMs: parseNumber(
    process.env.TG_BACKFILL_PAGE_DELAY_MS,
    1000,
    {
      integer: true,
      min: 0,
    },
  ),

  /**
   * Tokens provisioned per tick of the 5-minute roomless-token cron
   * (`CommunityRoomBackfillService.provisionRoomlessTokens`). Selects up to this
   * many tokens with `room_id IS NULL AND sale_address IS NOT NULL` and re-fires
   * the relay-room create + member seed for each. HARD-CAPPED at 100 (each token
   * is a sequential on-chain `get_state()` read + DB upsert): a smaller tick keeps
   * the recurring cron from saturating the pool; the working set is re-derived
   * every tick, so a backlog simply drains over more ticks.
   */
  roomProvisionBatchSize: parseNumber(
    process.env.TG_ROOM_PROVISION_BATCH,
    100,
    {
      integer: true,
      min: 1,
      max: 100,
    },
  ),

  /**
   * Schedule the eager room backfill (Task 09) on worker boot. Default `false`
   * (boot-safe): with this off, the worker never auto-enqueues the ~54k-token
   * sweep on module init — the kickoff must be triggered explicitly. Only honored
   * in the worker process. The `RoomBackfillService` boot gate reads
   * `process.env.TG_BACKFILL_ON_BOOT` directly; this knob mirrors it for consumers
   * that prefer the typed config.
   */
  backfillOnBoot: parseBool(process.env.TG_BACKFILL_ON_BOOT, false),

  /** publish-nip29 workers (conservative; avoid indexer starve). */
  publishConcurrency: parseNumber(process.env.TG_PUBLISH_CONCURRENCY, 2, {
    integer: true,
    min: 1,
  }),

  /** Token-bucket publish rate. */
  publishRatePerSec: parseNumber(process.env.TG_PUBLISH_RATE_PER_SEC, 100, {
    min: 1,
  }),

  /** Per-publish relay ACK timeout (ms). */
  publishAckTimeoutMs: parseNumber(
    process.env.TG_PUBLISH_ACK_TIMEOUT_MS,
    5000,
    {
      integer: true,
      min: 1,
    },
  ),

  /** Capped exponential backoff: max retries + backoff cap (ms, default 5m). */
  publishMaxRetries: parseNumber(process.env.TG_PUBLISH_MAX_RETRIES, 5, {
    integer: true,
    min: 0,
  }),
  publishBackoffCapMs:
    parseDurationSeconds(process.env.TG_PUBLISH_BACKOFF_CAP, 5 * 60) * 1000,

  /** Pause publishes on relay outage (seconds). */
  relayHealthPauseSec: parseNumber(process.env.TG_RELAY_HEALTH_PAUSE_SEC, 5, {
    min: 0,
  }),

  /** Reorg eviction buffer (blocks, §6.5). */
  reorgConfirmationDepthBlocks: parseNumber(
    process.env.TG_REORG_CONFIRMATION_DEPTH_BLOCKS,
    10,
    { integer: true, min: 0 },
  ),

  /** Reconciliation batch size + interval (default 500 / 10m). */
  reconcileBatchSize: parseNumber(process.env.TG_RECONCILE_BATCH_SIZE, 500, {
    integer: true,
    min: 1,
  }),
  reconcileIntervalSec: parseDurationSeconds(
    process.env.TG_RECONCILE_INTERVAL,
    10 * 60,
  ),

  /** Refresh the AEX9 filter allowlist (default 5m). */
  communityTokenRefreshSec: parseDurationSeconds(
    process.env.TG_COMMUNITY_TOKEN_REFRESH,
    5 * 60,
  ),

  /** New-message throttling: coalesce window (s) + per-recipient rate cap. */
  msgCoalesceWindowSec: parseNumber(
    process.env.TG_MSG_COALESCE_WINDOW_SEC,
    60,
    {
      integer: true,
      min: 0,
    },
  ),
  msgRateCap: parseNumber(process.env.TG_MSG_RATE_CAP, 0, {
    integer: true,
    min: 0,
  }),

  /**
   * Access-revoke debounce (access-ledger plan §4). When a member's room access is
   * lost (`relay_state → removed`), the "you no longer have access" push is held
   * this many seconds; if access is regained within the window (a transient
   * eligibility flap) NEITHER push fires. Default 180s. `0` disables the debounce
   * (revoke immediately) — not recommended while balances can flap.
   */
  accessRevokeGraceSec: parseDurationSeconds(
    process.env.TG_ACCESS_REVOKE_GRACE_SEC,
    180,
  ),

  /** room-notify queue depth that trips the §7.1 circuit-breaker. */
  roomNotifyDepthBreak: parseNumber(
    process.env.TG_ROOM_NOTIFY_DEPTH_BREAK,
    10000,
    {
      integer: true,
      min: 1,
    },
  ),

  /** Number of relay-subscriber shards (§7.1). */
  subscriberShards: parseNumber(process.env.TG_SUBSCRIBER_SHARDS, 1, {
    integer: true,
    min: 1,
  }),

  /** Constant Redis-isolation queue prefixes (not user-tunable, §9). */
  queuePrefixes: {
    main: QUEUE_PREFIX.main,
    worker: QUEUE_PREFIX.worker,
  },
}));

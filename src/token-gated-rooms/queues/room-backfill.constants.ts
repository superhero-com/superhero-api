import { prefixQueue } from '../config/queue-prefix';

/**
 * Constants for the eager room-backfill queue (Task 09).
 *
 * Worst case (stated for the load-test gate, §6.2 / Task 16): ~54k BCL factory
 * tokens × 2 group-level publishes (`9007` create-group + `9002` edit-metadata)
 * ≈ 108k publishes flowing through `worker:publish-nip29`. This path MUST be
 * load-tested against `groups_relay` before cutover; do NOT raise
 * `TG_PUBLISH_CONCURRENCY` / `TG_PUBLISH_RATE_PER_SEC` past their configured values.
 */

/**
 * Resolved queue name (`worker:room-backfill`) — registered + consumed worker-side
 * (canonical literal from Task 01's `prefixQueue`/`TGR_QUEUE_NAMES`). The driver
 * never steals `main:` indexer jobs because it runs under the `worker:` prefix.
 */
export const ROOM_BACKFILL_QUEUE = prefixQueue('room-backfill', 'worker');

/**
 * Bull job names on `worker:room-backfill`.
 *
 * - {@link BACKFILL_KICKOFF_JOB}: the driver loop — selects the next page of
 *   tokens needing a room and fans out one publish-sequence per token, then
 *   re-enqueues itself for the following page until the working set is empty.
 * - {@link BACKFILL_STALE_SWEEP_JOB}: re-publishes `pending` rows that have had
 *   no ACK for > 24h (relay idempotency makes the re-publish safe).
 */
export const BACKFILL_KICKOFF_JOB = 'backfill-kickoff';
export const BACKFILL_STALE_SWEEP_JOB = 'backfill-stale-sweep';

/** Single-row cursor PK in `room_backfill_state` (mirrors the indexer SyncState). */
export const ROOM_BACKFILL_STATE_ID = 'global';

/**
 * Env flag gating the eager backfill kickoff (Task 09, boot-safety): the full
 * AppModule loads in BOTH processes and tests boot the module, so the driver must
 * NEVER auto-run on module init (it would enqueue ~54k jobs and race app.close in
 * the boot smoke). The driver schedules nothing unless this is `'true'` AND the
 * process is the worker. NOTE: the integrator should also add `backfillOnBoot`
 * (parseBool, default false) to `tgr.config.ts` + a `TG_BACKFILL_ON_BOOT=false` row
 * to `.env.example`; this service reads `process.env` directly because the shared
 * config file is off-limits to this task.
 */
export const BACKFILL_ON_BOOT_ENV = 'TG_BACKFILL_ON_BOOT';

/**
 * A `pending` row with no ACK for longer than this is re-published (§4.7 — relay
 * idempotency makes the duplicate `9007`/`9002` a no-op). Stays `pending` (not a
 * state change). 24h in milliseconds.
 */
export const STALE_PENDING_MS = 24 * 60 * 60 * 1000;

/** Local `TG_BACKFILL_ON_BOOT`-style boolean parse (config file is off-limits, §wiring). */
export function parseBool(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  return value.trim().toLowerCase() === 'true';
}

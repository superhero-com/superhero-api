/**
 * Bull queue-name prefixing for the token-gated-rooms feature.
 *
 * TGR runs in ONE always-on process (worker mode removed — see `deworker-plan.md`),
 * but the queue NAMES keep their historical `main:`/`worker:` prefixes so a cutover
 * never orphans in-flight Redis jobs (DW5). The prefix is now purely a stable name
 * component; this helper remains the single source of that mapping.
 */

/**
 * The set of queue-ownership prefixes — a stable name component now that there is a
 * single process consuming every queue. Retained as `'main' | 'worker'` so the
 * existing registered queue names (`worker:publish-nip29`, `main:reconcile-balance`)
 * stay byte-for-byte identical across the cutover.
 */
export type QueueOwner = 'main' | 'worker';

/** Constant queue-name prefixes (not user-tunable env, plan §18). */
export const QUEUE_PREFIX = {
  main: 'main',
  worker: 'worker',
} as const;

/**
 * The five canonical base queue names (Shared contracts / plan §18). The map's
 * value is the process that **consumes** the queue and therefore the prefix it
 * must be registered under.
 */
export const TGR_QUEUE_NAMES = {
  PUBLISH_NIP29: 'publish-nip29',
  ROOM_BACKFILL: 'room-backfill',
  RECONCILE_BALANCE: 'reconcile-balance',
  RECONCILE_MEMBERSHIP: 'reconcile-membership',
  ROOM_NOTIFY: 'room-notify',
} as const;

/**
 * Canonical consumer for each base queue (plan §9): all relay/publish/notify
 * work runs in the **worker**; the `reconcile-balance` AEX9 sweep is driven by
 * the indexer (main). The owning tasks register their queue with the matching
 * prefix; this table documents the intended split.
 */
export const TGR_QUEUE_OWNER: Record<string, QueueOwner> = {
  [TGR_QUEUE_NAMES.PUBLISH_NIP29]: 'worker',
  [TGR_QUEUE_NAMES.ROOM_BACKFILL]: 'worker',
  [TGR_QUEUE_NAMES.RECONCILE_BALANCE]: 'main',
  [TGR_QUEUE_NAMES.RECONCILE_MEMBERSHIP]: 'worker',
  [TGR_QUEUE_NAMES.ROOM_NOTIFY]: 'worker',
};

/**
 * Returns the prefixed queue name: `` `${mode}:${baseName}` ``.
 *
 * @example prefixQueue('publish-nip29', 'worker') // 'worker:publish-nip29'
 * @example prefixQueue('reconcile-balance', 'main') // 'main:reconcile-balance'
 */
export function prefixQueue(baseName: string, owner: QueueOwner): string {
  return `${QUEUE_PREFIX[owner]}:${baseName}`;
}

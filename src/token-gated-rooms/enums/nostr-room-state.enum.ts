/**
 * `Token.nostr_room_state` machine (plan §4.7).
 *
 * States:
 *   - `none`    — no room requested yet (initial / default).
 *   - `pending` — `9007` create-group (and `9002` edit-metadata) enqueued/published,
 *                 awaiting relay ACK. A `pending` row stale > 24h without an ACK is
 *                 re-published (stays `pending`).
 *   - `created` — relay ACKed the group exists (`has_nostr_room=true`). Also reached
 *                 when the relay replies `"Group already exists"` for a `pending` create.
 *   - `failed`  — publish failed; retried with capped backoff back to `pending`.
 *   - `deleted` — community deleted → `9008` delete-group. **Terminal**: groups_relay
 *                 blocks recreate of a `9008`-deleted id, so no transitions leave here.
 *
 * Legal transitions (see {@link NOSTR_ROOM_STATE_TRANSITIONS}):
 *   none    → pending
 *   pending → created            (relay ACK, or `"Group already exists"`)
 *   pending → failed             (publish error)
 *   pending → deleted            (community deleted before ACK)
 *   failed  → pending            (retry, capped backoff)
 *   created → deleted            (community deleted)
 *   deleted → ∅                  (terminal)
 *
 * NOTE: a `pending` create that the relay answers with `"Group already exists"` is
 * treated as a successful `pending → created`. Re-publish of a stale `pending` row
 * (>24h, no ACK) is NOT a state change — it stays `pending`.
 *
 * Transition **enforcement** (only legal transitions allowed) is Task 09 — this file
 * is the schema/doc source of truth only and is exported for the unit tests.
 */
export type NostrRoomState =
  | 'none'
  | 'pending'
  | 'created'
  | 'failed'
  | 'deleted';

/** All values of {@link NostrRoomState}, in canonical order (used by the migration enum). */
export const NOSTR_ROOM_STATES: readonly NostrRoomState[] = [
  'none',
  'pending',
  'created',
  'failed',
  'deleted',
] as const;

/** Initial / default state for a freshly indexed token. */
export const NOSTR_ROOM_STATE_DEFAULT: NostrRoomState = 'none';

/**
 * Adjacency map of legal `nostr_room_state` transitions (plan §4.7).
 * `deleted` is terminal → empty outgoing set.
 */
export const NOSTR_ROOM_STATE_TRANSITIONS: Readonly<
  Record<NostrRoomState, readonly NostrRoomState[]>
> = {
  none: ['pending'],
  pending: ['created', 'failed', 'deleted'],
  created: ['deleted'],
  failed: ['pending'],
  deleted: [],
} as const;

/**
 * Pure predicate: is `from → to` a legal transition? (No side effects, no DB.)
 * Enforcement lives in Task 09; this exists for the unit tests + later guards.
 */
export const isLegalNostrRoomStateTransition = (
  from: NostrRoomState,
  to: NostrRoomState,
): boolean => NOSTR_ROOM_STATE_TRANSITIONS[from]?.includes(to) ?? false;

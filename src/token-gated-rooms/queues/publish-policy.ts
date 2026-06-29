/**
 * Pure retry/classification policy for the `publish-nip29` processor (Task 07 §4).
 *
 * No I/O — these helpers decide how a relay reject string is interpreted and how
 * long to back off, so the processor stays a thin orchestrator and the policy is
 * trivially unit-testable. Relay-reason strings are sourced from `groups_relay`:
 *   - `"Group already exists"` (`groups.rs:388`)            → benign no-op success
 *   - `"Only relay admin can create a managed group …"`     → terminal (D7)
 *   - `"…existed before and was deleted"` (`groups.rs:414`) → terminal (9008)
 */

/** Default capped-exponential backoff ceiling (5m) per §18. */
export const PUBLISH_BACKOFF_CAP_MS = 5 * 60 * 1000;

/** Base unit for the exponential backoff series (ms). */
export const PUBLISH_BACKOFF_BASE_MS = 1000;

/**
 * Capped exponential backoff: `base * 2^(attempt-1)` clamped to `capMs`.
 * `attemptsMade` is Bull's 1-based attempt number (1 = first retry delay).
 * Negative/zero attempts clamp to the base; the result never exceeds `capMs`.
 */
export function cappedExponentialBackoff(
  attemptsMade: number,
  baseMs: number = PUBLISH_BACKOFF_BASE_MS,
  capMs: number = PUBLISH_BACKOFF_CAP_MS,
): number {
  const n = Math.max(1, Math.floor(attemptsMade));
  // 2^(n-1) can overflow for large n; guard before multiplying.
  const factor = Math.pow(2, n - 1);
  const delay = Number.isFinite(factor) ? baseMs * factor : capMs;
  return Math.min(delay, capMs);
}

/** Lowercases an unknown error/reason into a comparable message string. */
export function reasonText(e: unknown): string {
  if (typeof e === 'string') {
    return e.toLowerCase();
  }
  const msg = (e as { message?: string } | null | undefined)?.message;
  return (msg ?? '').toLowerCase();
}

/**
 * True when a relay reject means the group already exists — a resumable-backfill
 * no-op that must resolve the job successfully (do NOT retry). Mirrors the
 * reference `isAlreadyExists()`: `"Group already exists"` or `"duplicate"`.
 */
export function isAlreadyExists(e: unknown): boolean {
  const msg = reasonText(e);
  return msg.includes('already exists') || msg.includes('duplicate');
}

/**
 * True when a relay reject is PERMANENT and must fail fast (no retry, surface for
 * alerting): the bot is not the relay admin, or the group was deleted (9008).
 */
export function isTerminalReject(e: unknown): boolean {
  const msg = reasonText(e);
  return (
    msg.includes('only relay admin') ||
    (msg.includes('was deleted') && msg.includes('existed before')) ||
    msg.includes('group existed before and was deleted')
  );
}

/**
 * True when a relay reject means the target group does not exist on the relay
 * (`groups_relay` answers member/metadata ops with `"... Group not found"`). This
 * is NOT permanent: the group can be (re)created. It signals a DB↔relay desync —
 * the API thinks the room is created (`room_id`/`nostr_room_state='created'`) but
 * the relay has no such group (e.g. its data was reset). The owner re-creates the
 * group, then the deferred member adds succeed.
 */
export function isGroupNotFound(e: unknown): boolean {
  return reasonText(e).includes('group not found');
}

/** A non-retryable error wrapper so Bull does not re-attempt terminal rejects. */
export class TerminalPublishError extends Error {
  readonly terminal = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'TerminalPublishError';
  }
}

/** Extracts the `["p", pubkey, …]` member pubkey from a template, if present. */
export function pubkeyFromTags(tags: string[][]): string | undefined {
  for (const tag of tags) {
    if (tag[0] === 'p' && typeof tag[1] === 'string') {
      return tag[1];
    }
  }
  return undefined;
}

/**
 * Every abort the SocialContract can produce, mapped to the HTTP status the
 * client renders. None is invented and nothing raw is re-thrown — this is the
 * whole point of keeping the mapping server-side (Model A): both clients read
 * one typed contract instead of hand-writing the two-bucket UX twice, once in a
 * repo with no CI.
 *
 * Bucket A — stale-state races (409): the client re-reads the relationship,
 * reconciles silently, shows no error.
 * Bucket B — surfaced with actionable copy: BLOCKED (403, neutral), and the
 * recoverable caps / cooldown.
 */
export const SOCIAL_GRAPH_ABORT_STATUS = {
  // Bucket A — stale-state races.
  ALREADY_FOLLOWING: 409,
  NOT_FOLLOWING: 409,
  ALREADY_BLOCKED: 409,
  NOT_BLOCKED: 409,
  CANNOT_FOLLOW_SELF: 409,
  CANNOT_BLOCK_SELF: 409,
  // Bucket B — surfaced.
  BLOCKED: 403,
  // Caller has blocked the target: distinct code so the client can offer
  // "unblock to follow" inline, vs the neutral BLOCKED above.
  BLOCKED_BY_SELF: 409,
  // Recoverable — the cap is on concurrent list size, not lifetime; unfollowing
  // / unblocking frees a slot.
  MAX_FOLLOWING_REACHED: 409,
  MAX_BLOCKED_REACHED: 409,
  // Unreachable while follow_cooldown = 0, and still mapped: a future redeploy
  // could carry a non-zero value and this must not fall through as a 500.
  FOLLOW_COOLDOWN: 429,
} as const;

export type SocialGraphAbortCode = keyof typeof SOCIAL_GRAPH_ABORT_STATUS;

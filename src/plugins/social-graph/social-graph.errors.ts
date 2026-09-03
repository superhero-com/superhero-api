// Every SocialContract abort mapped to its HTTP status. 409 = stale-state race
// (client re-reads and reconciles); 403 = BLOCKED (neutral); 429 = cooldown.
export const SOCIAL_GRAPH_ABORT_STATUS = {
  ALREADY_FOLLOWING: 409,
  NOT_FOLLOWING: 409,
  ALREADY_BLOCKED: 409,
  NOT_BLOCKED: 409,
  CANNOT_FOLLOW_SELF: 409,
  CANNOT_BLOCK_SELF: 409,
  BLOCKED: 403,
  // Distinct from BLOCKED so the client can offer "unblock to follow" inline.
  BLOCKED_BY_SELF: 409,
  MAX_FOLLOWING_REACHED: 409,
  MAX_BLOCKED_REACHED: 409,
  // Unreachable at follow_cooldown=0; mapped so a non-zero redeploy is not a 500.
  FOLLOW_COOLDOWN: 429,
} as const;

export type SocialGraphAbortCode = keyof typeof SOCIAL_GRAPH_ABORT_STATUS;

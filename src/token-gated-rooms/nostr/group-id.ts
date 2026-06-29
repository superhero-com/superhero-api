/**
 * NIP-29 group-id resolution for token-gated rooms.
 *
 * D3 (plan §6.4): the group id is `Token.sale_address` taken **verbatim** and
 * persisted once in `Token.nostr_group_id`. The `groups_relay` accepts the id
 * straight off the `h` tag with NO charset check and NO lowercasing
 * (`extract_group_id`, `group.rs:1370`), so we must NOT derive, slugify, hash,
 * or lowercase it here. This is the deliberate divergence from the bot's
 * `groupId.ts` (which sha256-derives an id) — see Task 07.
 *
 * `TG_GROUP_ID_PREFIX` is therefore unused on the default path; it is legacy
 * and only relevant if a derived-id scheme is ever reintroduced.
 */
export interface TokenLikeForGroupId {
  /** æternity sale contract address — the canonical group id (`ct_…`). */
  sale_address: string;
  /** Persisted group id (set once = `sale_address`); preferred when present. */
  nostr_group_id?: string | null;
}

/**
 * Returns the NIP-29 group id for a token: the already-persisted
 * `nostr_group_id` when set, otherwise the `sale_address` — **verbatim**. No
 * normalization of any kind (mixed-case `ct_…` is preserved exactly).
 */
export function groupIdFor(token: TokenLikeForGroupId): string {
  return token.nostr_group_id ?? token.sale_address;
}

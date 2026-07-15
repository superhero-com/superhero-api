/**
 * Stable group-id → shard assignment for the relay subscriber (Task 14, plan §7.1).
 *
 * The kind-9/11 firehose is split across `TG_SUBSCRIBER_SHARDS` subscriber instances
 * so a single socket never has to ingest + fan-out every room's messages. Each
 * instance owns one shard index and only subscribes for / processes events whose
 * group id maps to its index. The assignment MUST be:
 *   - **pure + deterministic** — the same gid always maps to the same shard, in
 *     every process, with no shared state (so two instances agree on ownership);
 *   - **range-bound** — always in `[0, shardCount)`;
 *   - **reasonably balanced** — sample gids spread roughly evenly across shards.
 *
 * `shardCount = 1` (the default) collapses to "one shard owns everything" → the
 * function always returns `0`. Raising the count per the §7.1 sizing model splits
 * the firehose; the partition is the testable unit (how the index reaches an
 * instance — env/ordinal — is a deployment concern, see {@link resolveShardIndex}).
 */

/**
 * FNV-1a 32-bit hash of a UTF-8 string. A small, well-distributed,
 * dependency-free non-cryptographic hash — we only need an even spread across a
 * handful of shards, not collision resistance. Kept inline (vs. importing a hash
 * lib) so the hot path has zero allocation beyond the loop.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // Use the high/low byte separately so multi-byte code units still mix in.
    const hi = (input.charCodeAt(i) >> 8) & 0xff;
    if (hi !== 0) {
      hash = Math.imul(hash, 0x01000193);
      hash ^= hi;
    }
    hash = Math.imul(hash, 0x01000193); // FNV prime, 32-bit via Math.imul
  }
  // Math.imul yields a signed 32-bit int; fold to unsigned.
  return hash >>> 0;
}

/**
 * Assign a group id to a shard index in `[0, shardCount)` via a stable hash mod
 * `shardCount`. Pure: no globals, no I/O. `shardCount <= 1` ⇒ always `0`.
 *
 * @param groupId    the NIP-29 group id (= `Token.sale_address`), verbatim.
 * @param shardCount total number of subscriber shards (`TG_SUBSCRIBER_SHARDS`).
 */
export function shardForGroupId(groupId: string, shardCount: number): number {
  if (!Number.isFinite(shardCount) || shardCount <= 1) {
    return 0;
  }
  const count = Math.floor(shardCount);
  return fnv1a32(groupId) % count;
}

/**
 * Resolve THIS subscriber instance's shard index from the environment. The index
 * is supplied per-instance via `TG_SUBSCRIBER_SHARD_INDEX` (a 0-based ordinal, e.g.
 * the StatefulSet pod ordinal). Out-of-range / unset ⇒ `0` (single-shard default),
 * so an unsharded worker simply owns the whole firehose.
 *
 * @param env        process env (injected for testability).
 * @param shardCount total shard count (`TG_SUBSCRIBER_SHARDS`).
 */
export function resolveShardIndex(
  env: Record<string, string | undefined>,
  shardCount: number,
): number {
  const raw = env.TG_SUBSCRIBER_SHARD_INDEX;
  if (raw === undefined || raw.trim() === '') {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= shardCount) {
    return 0;
  }
  return parsed;
}

/**
 * Whether THIS shard (`shardIndex`) owns a given group id. The membership test the
 * subscriber applies before subscribing-to / processing a room.
 */
export function ownsGroupId(
  groupId: string,
  shardIndex: number,
  shardCount: number,
): boolean {
  return shardForGroupId(groupId, shardCount) === shardIndex;
}

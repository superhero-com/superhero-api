import { EntityManager } from 'typeorm';

/**
 * Recompute the two follow counters for one address from `social_graph_edges`
 * and upsert them into `social_graph_counts`, using the caller's transaction.
 *
 * The value is a pure function of the edge table, never a delta, so every writer
 * — a replayed event, a reorg bulk-delete, a re-sync from the start height —
 * converges on the same number. Run inside the same transaction as the edge
 * mutation so a crash between the two cannot leave a stale counter.
 */
export async function recomputeSocialGraphCounts(
  manager: EntityManager,
  address: string,
): Promise<void> {
  // $1 is cast so Postgres deduces one type for it across the INSERT target and
  // both subquery predicates — an uncast parameter reused this way is rejected
  // with "inconsistent types deduced for parameter $1".
  await manager.query(
    `INSERT INTO social_graph_counts (address, followers_count, following_count, updated_at)
     VALUES (
       $1::varchar,
       (SELECT COUNT(*) FROM social_graph_edges WHERE to_address   = $1::varchar AND kind = 'follow'),
       (SELECT COUNT(*) FROM social_graph_edges WHERE from_address = $1::varchar AND kind = 'follow'),
       now()
     )
     ON CONFLICT (address) DO UPDATE
       SET followers_count = EXCLUDED.followers_count,
           following_count = EXCLUDED.following_count,
           updated_at      = now()`,
    [address],
  );
}

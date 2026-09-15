import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One-shot recovery watermark for `SocialGraphBackfillService`. Keyed by
 * contract address so a redeploy (new address) recovers from scratch.
 * `last_backfilled_height` is the highest block the walk has fully reprocessed;
 * the next boot stops as soon as it reaches a call at or below it, so recovery
 * runs once and later boots do not replay the already-recovered history.
 *
 * A first walk over a call history larger than the page-safety window can only
 * reach the newest ~5,000 calls before it stops; `last_backfilled_height` is
 * left null so nothing is marked done, and `resume_from_height` / `pending_high`
 * carry the walk across boots so the older calls are still reached. Both are null
 * in steady state (walk complete) and non-null only while a truncated backfill is
 * still in progress.
 */
@Entity({ name: 'social_graph_backfill_state' })
export class SocialGraphBackfillState {
  @PrimaryColumn()
  contract_address: string;

  @Column({ type: 'int', nullable: true })
  last_backfilled_height: number | null;

  // Generation the next boot resumes the newest-first walk at (inclusive, scope
  // gen:<this>-0), so a page-safety-truncated first walk continues downward
  // instead of restarting at the newest page and truncating at the same point.
  @Column({ type: 'int', nullable: true })
  resume_from_height: number | null;

  // Highest block seen while a truncated backfill is still in progress; promoted
  // to `last_backfilled_height` once the walk finally completes.
  @Column({ type: 'int', nullable: true })
  pending_high_height: number | null;

  // Plugin version this watermark was recovered at. A version bump means the
  // decode logic changed, so the edge table must be rebuilt from the whole
  // history — the re-decode sweep (`getUpdateQueries`) only re-stamps the tx
  // jsonb and never touches the edge table. On a mismatch the next boot ignores
  // the watermark and re-walks from the top, reprocessing every call through the
  // idempotent `processBatch` path. Null on rows written before this column.
  @Column({ type: 'int', nullable: true })
  version: number | null;

  @Column({ type: 'timestamp', default: () => 'now()' })
  updated_at: Date;
}

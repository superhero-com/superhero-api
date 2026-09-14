import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One-shot recovery watermark for `SocialGraphBackfillService`. Keyed by
 * contract address so a redeploy (new address) recovers from scratch.
 * `last_backfilled_height` is the highest block the walk has fully reprocessed;
 * the next boot stops as soon as it reaches a call at or below it, so recovery
 * runs once and later boots do not replay the already-recovered history.
 */
@Entity({ name: 'social_graph_backfill_state' })
export class SocialGraphBackfillState {
  @PrimaryColumn()
  contract_address: string;

  @Column({ type: 'int', nullable: true })
  last_backfilled_height: number | null;

  @Column({ type: 'timestamp', default: () => 'now()' })
  updated_at: Date;
}

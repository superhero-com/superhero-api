import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Maintained follower/following counters for one address, kept in step with
 * `social_graph_edges` on every edge mutation. The stored value is always
 * recomputed as `COUNT(*)` over the edge table for that address, never a
 * `+1`/`-1` delta — so a replayed event, a reorg cleanup or a full re-sync all
 * converge on the same number and it cannot drift from the reconcile check.
 *
 * A missing row means an address nobody follows and who follows nobody: the read
 * path treats that as `{ followers_count: 0, following_count: 0 }`.
 */
@Entity({ name: 'social_graph_counts' })
export class SocialGraphCount {
  @PrimaryColumn()
  address: string;

  @Column({ type: 'int', default: 0 })
  followers_count: number;

  @Column({ type: 'int', default: 0 })
  following_count: number;

  @Column({ type: 'timestamp', default: () => 'now()' })
  updated_at: Date;
}

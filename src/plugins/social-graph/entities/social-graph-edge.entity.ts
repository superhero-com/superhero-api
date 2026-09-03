import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type SocialGraphEdgeKind = 'follow' | 'block';

export const SOCIAL_GRAPH_EDGE_FOLLOW: SocialGraphEdgeKind = 'follow';
export const SOCIAL_GRAPH_EDGE_BLOCK: SocialGraphEdgeKind = 'block';

/**
 * One directed edge in the on-chain social graph: `from_address` follows or
 * blocks `to_address`, derived from the SocialContract
 * Followed/Unfollowed/Blocked/Unblocked events.
 *
 * Rows are DELETED on Unfollowed/Unblocked — the contract keeps no history and
 * neither do we; the middleware is the audit trail. There is deliberately no
 * denormalised counter column: a cached count is a second source of truth that
 * drifts from the reconcile check, so counts are `COUNT(*)` over this table.
 */
@Entity({ name: 'social_graph_edges' })
@Unique('uq_social_graph_edge', ['from_address', 'to_address', 'kind'])
// Followers direction: COUNT(*) WHERE to_address = ? AND kind = 'follow'.
// Without this every profile view is a sequential scan. The following direction
// rides the unique index's leading `from_address` column.
@Index('idx_social_graph_edge_to_kind', ['to_address', 'kind'])
export class SocialGraphEdge {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  from_address: string;

  @Column()
  to_address: string;

  @Column()
  kind: SocialGraphEdgeKind;

  @Column({ type: 'int' })
  height: number;

  @Column()
  tx_hash: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}

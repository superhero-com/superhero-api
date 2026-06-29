import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import { BigNumber } from 'bignumber.js';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Indexed RoomManagement state for a token-gated room (plan §4.2).
 *
 * PK is `sale_address` (= the NIP-29 group id, D3). Communities take policy from
 * `CommunityManagement`; plain token-gated rooms use defaults. Written by the
 * community-room-state indexer (Task 04); this entity is schema only.
 */
@Entity({ name: 'community_room' })
@Index('idx_community_room_state_synced_at', ['state_synced_at'])
@Index('idx_community_room_moderators', { synchronize: false })
@Index('idx_community_room_muted', { synchronize: false })
export class CommunityRoom {
  @PrimaryColumn()
  sale_address: string;

  @Column()
  token_address: string;

  @Column()
  symbol: string;

  @Column()
  owner_address: string;

  @Index('idx_community_room_is_private')
  @Column({
    default: false,
  })
  is_private: boolean;

  /**
   * Minimum balance to be eligible, stored as **raw integer base units** (plan
   * §5.4; compare raw-vs-raw). Round-trips through `BigNumberTransformer`.
   */
  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  min_token_threshold: BigNumber;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  moderators: string[];

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  muted: string[];

  @Column({
    default: false,
  })
  is_community: boolean;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  state_synced_at: Date;

  @Column({
    type: 'int',
    nullable: true,
  })
  created_height: number;

  @Column({
    default: false,
  })
  deleted: boolean;
}

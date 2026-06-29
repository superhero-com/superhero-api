import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** On-relay membership lifecycle for a desired-state row (plan §4.3). */
export type RoomMembershipRelayState =
  | 'pending_add'
  | 'added'
  | 'pending_remove'
  | 'removed';

/** NIP-29 role of a member within a room (plan §4.3). */
export type RoomMembershipRole = 'member' | 'admin';

export const ROOM_MEMBERSHIP_ROLES: readonly RoomMembershipRole[] = [
  'member',
  'admin',
] as const;

export const ROOM_MEMBERSHIP_RELAY_STATES: readonly RoomMembershipRelayState[] =
  ['pending_add', 'added', 'pending_remove', 'removed'] as const;

/**
 * Desired-state membership ledger (plan §4.3). Relay `39002` is the source of
 * truth; this is the desired-state + cache used by membership-sync (Task 10) and
 * reconciliation (Task 11). Schema only here.
 */
@Entity({ name: 'room_membership' })
@Index('uq_room_membership_sale_member', ['sale_address', 'member_address'], {
  unique: true,
})
@Index('idx_room_membership_sale_relay_state', ['sale_address', 'relay_state'])
@Index('idx_room_membership_member_address', ['member_address'])
@Index('idx_room_membership_eligible', ['sale_address'], {
  where: 'eligible = true',
})
export class RoomMembership {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  sale_address: string;

  @Column()
  member_address: string;

  /** Resolved hex Nostr pubkey (npub→hex normalized); null until linked (§6.6). */
  @Column({
    type: 'varchar',
    nullable: true,
  })
  member_pubkey: string;

  @Column({
    type: 'enum',
    enum: ROOM_MEMBERSHIP_ROLES,
    default: 'member',
  })
  role: RoomMembershipRole;

  @Column({
    default: false,
  })
  eligible: boolean;

  @Column({
    type: 'enum',
    enum: ROOM_MEMBERSHIP_RELAY_STATES,
    default: 'pending_add',
  })
  relay_state: RoomMembershipRelayState;

  /** Reorg eviction buffer: hold removal until this height passes (§6.5). */
  @Column({
    type: 'int',
    nullable: true,
  })
  held_until_height: number;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  last_published_at: Date;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  last_reconciled_at: Date;

  @UpdateDateColumn({
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}

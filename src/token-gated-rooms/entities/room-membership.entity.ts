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

/**
 * Last **notified** effective-access state (access-ledger plan). Decoupled from
 * `relay_state` (a sync signal that churns): notifications are driven off
 * transitions of THIS field, so reconcile re-adds / `39002` regeneration / a
 * transient flap absorbed within the grace window never re-notify.
 * `granted` ⇔ the member currently has room access (was `relay_state='added'`).
 */
export type RoomMembershipAccessState = 'none' | 'granted';

export const ROOM_MEMBERSHIP_ACCESS_STATES: readonly RoomMembershipAccessState[] =
  ['none', 'granted'] as const;

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

  /**
   * Last **notified** effective-access state (access-ledger plan). Drives the
   * membership push instead of the raw `relay_state` ACK, so relay-sync churn
   * (reconcile re-adds, `39002` regeneration, flaps absorbed within the grace
   * window) never re-notifies. Written only by `MembershipAccessService`.
   */
  @Column({
    type: 'enum',
    enum: ROOM_MEMBERSHIP_ACCESS_STATES,
    default: 'none',
  })
  access_state: RoomMembershipAccessState;

  /** When `access_state` last flipped (audit/observability). */
  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  access_changed_at: Date;

  /**
   * Debounce timer: set when access is lost (`relay_state → removed`); if still
   * set + still-removed after `TG_ACCESS_REVOKE_GRACE_SEC`, the finalizer emits a
   * single `access_revoked`. Cleared if access is regained first (flap absorbed —
   * no push either way). NULL = no pending revoke.
   */
  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  pending_revoke_since: Date;

  /** Reason carried through the revoke debounce for the finalizer's event row. */
  @Column({
    type: 'varchar',
    nullable: true,
  })
  pending_revoke_reason: string;

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

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Access transition recorded in the ledger (access-ledger plan §3.3). */
export type RoomMembershipEventType = 'access_granted' | 'access_revoked';

export const ROOM_MEMBERSHIP_EVENT_TYPES: readonly RoomMembershipEventType[] = [
  'access_granted',
  'access_revoked',
] as const;

/**
 * Append-only **access-transition ledger** (access-ledger plan §3.3). One row per
 * *genuine* access change of a `(sale_address, member_address)` — the durable,
 * restart-safe source for BOTH the "you're in" and "you lost access" pushes, and
 * the audit trail used to see whether/why eligibility still flaps.
 *
 * Why a table (vs a Redis dedup key / a single column):
 *  - durable dedup — survives process restarts (a Redis TTL does not);
 *  - one uniform source drives grant + revoke pushes;
 *  - `is_first_grant` distinguishes a genuine first join ("Welcome") from a
 *    re-grant after a real lapse ("You're back");
 *  - row-by-row history is exactly what's needed to diagnose flapping (each flap
 *    = a granted/revoked pair, with reasons).
 *
 * Rows are written ONLY by {@link MembershipAccessService} on a real effective-access
 * transition (grant immediately; revoke after the debounce grace). The push is
 * enqueued off inserting a row; `notified_at` is stamped by the room-notify
 * processor on successful dispatch (belt-and-suspenders dedup: never re-push a
 * stamped event on a Bull retry).
 */
@Entity({ name: 'room_membership_event' })
@Index('idx_room_membership_event_sale_member', [
  'sale_address',
  'member_address',
  'created_at',
])
@Index('idx_room_membership_event_unnotified', ['notified_at'], {
  where: 'notified_at IS NULL',
})
export class RoomMembershipEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column()
  sale_address: string;

  @Column()
  member_address: string;

  @Column({
    type: 'enum',
    enum: ROOM_MEMBERSHIP_EVENT_TYPES,
  })
  event: RoomMembershipEventType;

  /**
   * Why access changed — audit/telemetry. e.g. `join`, `regained` (grants);
   * `eligibility_lost`, `room_deleted`, `reorg_evicted`, `access_lost` (revokes).
   */
  @Column({ type: 'varchar' })
  reason: string;

  /** True iff no prior `access_granted` exists for `(sale, member)` (copy). */
  @Column({ default: false })
  is_first_grant: boolean;

  @CreateDateColumn({
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;

  /** Stamped when the push is dispatched; NULL = not yet pushed. */
  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  notified_at: Date;
}

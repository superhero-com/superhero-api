import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Per-room mute preference (plan §4.4). Composite PK `(address, sale_address)`.
 * Mute-all is the type-level `room-messages` switch; this is the per-room override.
 * Behavior owned by Task 12; schema only here.
 */
@Entity({ name: 'room_notification_preference' })
export class RoomNotificationPreference {
  @PrimaryColumn()
  address: string;

  @PrimaryColumn()
  sale_address: string;

  @Column({
    default: false,
  })
  muted: boolean;

  @UpdateDateColumn({
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}

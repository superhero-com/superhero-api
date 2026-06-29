import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Dedup key for new-message notifications (plan §7.1). PK is the Nostr `event_id`,
 * so a re-delivered relay event is only notified once. Written by the relay
 * subscriber (Task 14); schema only here.
 */
@Entity({ name: 'room_message_seen' })
@Index('idx_room_message_seen_sale_address', ['sale_address'])
export class RoomMessageSeen {
  @PrimaryColumn()
  event_id: string;

  @Column()
  sale_address: string;

  @Column({
    type: 'timestamptz',
    default: () => 'now()',
  })
  seen_at: Date;
}

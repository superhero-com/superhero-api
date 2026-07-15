import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Single-row resume cursor for the eager room backfill (plan §4.6 / §6.2),
 * mirroring the `SyncState`/indexer cursor pattern: a fixed PK `id='global'`,
 * the last height reached, and the in-batch offset. Written by the backfill
 * queue (Task 09); schema only here.
 */
@Entity({ name: 'room_backfill_state' })
export class RoomBackfillState {
  @PrimaryColumn({ default: 'global' })
  id: string;

  @Column({
    type: 'int',
    nullable: true,
  })
  last_height: number;

  @Column({
    type: 'int',
    default: 0,
  })
  batch_offset: number;

  @UpdateDateColumn({
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}

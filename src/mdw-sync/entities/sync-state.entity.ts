import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'sync_state',
})
export class SyncState {
  @PrimaryColumn({ default: 'global' })
  id: string;

  @Column()
  last_synced_height: number;

  @Column()
  last_synced_hash: string;

  @Column()
  tip_height: number;

  @Column({ default: false })
  is_bulk_mode: boolean;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}

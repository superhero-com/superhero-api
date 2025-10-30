import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'mdw_plugin_sync_state',
})
@Index(['plugin_name'])
@Index(['is_active'])
export class MdwPluginSyncState {
  @PrimaryColumn()
  plugin_name: string;

  @Column()
  last_synced_height: number;

  @Column()
  start_from_height: number;

  @Column({ default: true })
  is_active: boolean;

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

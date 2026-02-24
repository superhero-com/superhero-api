import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({
  name: 'profile_sync_state',
})
export class ProfileSyncState {
  @PrimaryColumn()
  id: string;

  @Column({
    type: 'bigint',
    default: '0',
  })
  last_indexed_micro_time: string;
}

import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({
  name: 'synced_blocks',
})
export class SyncedBlock {
  @PrimaryColumn()
  block_number: number; // block number

  @Column({
    default: 0,
  })
  total_bcl_transactions: number;

  @Column('text', { array: true })
  synced_tx_hashes: string[];

  @Column('text', { array: true })
  callers: string[];

  @Column({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

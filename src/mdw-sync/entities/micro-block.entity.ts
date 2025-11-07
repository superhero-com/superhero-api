import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity({
  name: 'micro_blocks',
})
@Index(['height'])
@Index(['hash'])
@Index(['prev_hash'])
@Index(['prev_key_hash'])
export class MicroBlock {
  @PrimaryColumn()
  hash: string;

  @Column()
  height: number;

  @Column()
  prev_hash: string;

  @Column()
  prev_key_hash: string;

  @Column()
  state_hash: string;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  time: string;

  @Column({ default: 0 })
  transactions_count: number;

  @Column({ type: 'text' })
  flags: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ default: 0 })
  gas: number;

  @Column({ default: 0 })
  micro_block_index: number;

  @Column()
  pof_hash: string;

  @Column()
  signature: string;

  @Column()
  txs_hash: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'kbs',
})
@Index(['height'])
@Index(['hash'])
@Index(['prev_hash'])
@Index(['prev_key_hash'])
export class KeyBlock {
  @PrimaryColumn()
  height: number;

  @Column({ unique: true })
  hash: string;

  @Column()
  prev_hash: string;

  @Column()
  prev_key_hash: string;

  @Column()
  state_hash: string;

  @Column()
  beneficiary: string;

  @Column()
  miner: string;

  @Column({ type: 'bigint' })
  time: string;

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @Column({ default: 0 })
  transactions_count: number;

  @Column({ default: 0 })
  micro_blocks_count: number;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  beneficiary_reward: string;

  @Column({ type: 'text' })
  flags: string;

  @Column({ type: 'text' })
  info: string;

  @Column({ type: 'bigint' })
  nonce: string;

  @Column({ type: 'jsonb' })
  pow: number[];

  @Column({ type: 'bigint' })
  target: string;

  @Column({ type: 'int' })
  version: number;

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

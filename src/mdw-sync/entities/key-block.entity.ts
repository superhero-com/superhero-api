import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity({
  name: 'key_blocks',
})
@Index(['height'])
@Index(['hash'])
@Index(['prev_hash'])
@Index(['prev_key_hash'])
export class KeyBlock {
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

  @Column()
  beneficiary: string;

  @Column()
  miner: string;

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  time: string;

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

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  nonce: string;

  @Column({ type: 'jsonb' })
  pow: number[];

  @Column({
    type: 'numeric',
    precision: 78, // total digits (fits uint256)
    scale: 0, // no decimals — store in base units (wei, satoshi, etc.)
    default: '0',
  })
  target: string;

  @Column({ type: 'int' })
  version: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}

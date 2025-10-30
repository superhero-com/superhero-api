import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'mdw_block',
})
@Index(['height'])
@Index(['hash'])
@Index(['parent_hash'])
export class MdwBlock {
  @PrimaryColumn()
  height: number;

  @Column({ unique: true })
  hash: string;

  @Column()
  parent_hash: string;

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

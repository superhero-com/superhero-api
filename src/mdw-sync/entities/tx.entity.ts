import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { KeyBlock } from './key-block.entity';
import { MicroBlock } from './micro-block.entity';
@Entity({
  name: 'txs',
})
@Index(['hash'])
@Index(['block_height'])
@Index(['type'])
@Index(['contract_id'])
@Index(['function'])
export class Tx {
  @PrimaryColumn()
  hash: string;

  @Column()
  block_hash: string;

  @ManyToOne(() => MicroBlock, (block) => block.hash, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'block_hash', referencedColumnName: 'hash' })
  block: MicroBlock;

  @Column()
  block_height: number;

  @Column({
    default: 1,
  })
  version: number;

  @Column({
    nullable: true,
  })
  encoded_tx: string;

  @Column({ type: 'bigint' })
  micro_index: string;

  @Column({ type: 'bigint' })
  micro_time: string;

  @Column({ type: 'jsonb' })
  signatures: string[];

  @Column()
  type: string; // 'contract_call' | 'spend' | etc.

  @Column({
    nullable: true,
  })
  payload: string;

  @Column({ nullable: true })
  contract_id?: string; // TODO: should reference to contract

  @Column({ nullable: true })
  function?: string;

  @Column({ nullable: true })
  caller_id?: string; // TODO: should reference to account

  @Column({ nullable: true })
  sender_id?: string; // TODO: should reference to account

  @Column({ nullable: true })
  recipient_id?: string; // TODO: should reference to account

  @Column({ type: 'jsonb' })
  raw: any;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;
}

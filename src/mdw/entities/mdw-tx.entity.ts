import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({
  name: 'mdw_tx',
})
@Index(['block_height'])
@Index(['tx_hash'])
@Index(['type'])
@Index(['contract_id'])
@Index(['function'])
export class MdwTx {
  @PrimaryColumn()
  tx_hash: string;

  @Column()
  block_height: number;

  @Column()
  block_hash: string;

  @Column({ type: 'bigint' })
  micro_time: string;

  @Column()
  type: string; // 'contract_call' | 'spend' | etc.

  @Column({ nullable: true })
  contract_id?: string;

  @Column({ nullable: true })
  function?: string;

  @Column({ nullable: true })
  caller_id?: string;

  @Column({ nullable: true })
  sender_id?: string;

  @Column({ nullable: true })
  recipient_id?: string;

  @Column({ type: 'jsonb' })
  raw: any;

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

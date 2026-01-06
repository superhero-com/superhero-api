import { Column, Entity, PrimaryColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';

@Entity({
  name: 'bcl_transactions',
})
export class BclTransaction {
  @PrimaryColumn({ name: 'hash' })
  hash: string;

  @ManyToOne(() => Tx, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'hash', referencedColumnName: 'hash' })
  tx: Tx;

  @Column()
  @Index()
  block_hash: string;

  @Column({ type: 'bigint' })
  micro_time: number;

  @Column()
  block_height: number;

  @Column({ nullable: true })
  @Index()
  caller_id?: string;

  @Column()
  @Index()
  function: string;

  @Column({ type: 'timestamp' })
  created_at: Date;

  @Column({ type: 'jsonb', nullable: true })
  amount: any;

  @Column({ type: 'varchar', nullable: true })
  volume?: string;

  @Column({ type: 'varchar', nullable: true })
  tx_type?: string;

  @Column({ type: 'jsonb', nullable: true })
  buy_price: any;

  @Column({ type: 'jsonb', nullable: true })
  sell_price?: any;

  @Column({ type: 'jsonb', nullable: true })
  market_cap?: any;

  @Column({ type: 'jsonb', nullable: true })
  unit_price?: any;

  @Column({ type: 'jsonb', nullable: true })
  previous_buy_price?: any;

  @Column({ type: 'varchar', nullable: true })
  @Index('IDX_BCL_TX_SALE_ADDRESS_CREATED_AT', ['sale_address', 'created_at'])
  sale_address?: string;

  @Column({ type: 'varchar', nullable: true })
  total_supply?: string;

  @Column({ type: 'varchar', nullable: true })
  protocol_reward?: string;

  @Column({ type: 'int', default: 1 })
  _version: number;

  @Column({ type: 'boolean', default: false })
  verified: boolean;
}


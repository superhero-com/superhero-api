import { Column, Entity, PrimaryColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';

@Entity({
  name: 'bcl_tokens',
})
export class BclToken {
  @PrimaryColumn()
  @Index({ unique: true })
  sale_address: string;

  @Column({ default: false })
  unlisted: boolean;

  @Column()
  @Index()
  factory_address: string;

  @Column()
  create_tx_hash: string;

  @Column()
  dao_address: string;

  @Column()
  @Index()
  creator_address: string;

  @Column({ nullable: true })
  beneficiary_address: string;

  @Column({ nullable: true })
  bonding_curve_address: string;

  // should come from latest transaction on bcl_transactions table
  @Column({ type: 'jsonb', nullable: true })
  dao_balance: any;

  @Column()
  @Index()
  owner_address: string;

  @Column({
    nullable: true,
  })
  @Index()
  address: string;

  @Column()
  @Index()
  name: string;

  @Column()
  @Index()
  symbol: string;

  @Column({ type: 'int', default: 18 })
  decimals: number;

  @Column({ nullable: true })
  collection: string;

  @Column({ type: 'numeric', default: 0 })
  trending_score: number;

  @Column({ type: 'timestamp', nullable: true })
  trending_score_update_at: Date;

  @Column({ type: 'timestamp' })
  created_at: Date;

  @ManyToOne(() => Tx, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'create_tx_hash', referencedColumnName: 'hash' })
  create_tx: Tx;
}


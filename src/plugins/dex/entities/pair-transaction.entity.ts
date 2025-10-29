import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Pair } from './pair.entity';
import { MdwTx } from '@/mdw/entities/mdw-tx.entity';

@Entity({
  name: 'dex_transactions',
})
export class PairTransaction {
  @PrimaryColumn()
  tx_hash: string;

  @Column({
    nullable: true,
  })
  account_address: string;

  // block height
  @Column({
    default: 0,
  })
  block_height: number;

  @ManyToOne(() => Pair, (pair) => pair.address, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'pair_address' })
  pair: Pair;

  @ManyToOne(() => MdwTx, (tx) => tx.tx_hash, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tx_hash', referencedColumnName: 'tx_hash' })
  mdwTx: MdwTx;

  @Column()
  tx_type: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  reserve0: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  reserve1: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  ratio0: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  ratio1: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  total_supply: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  volume0: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  volume1: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  market_cap0: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  market_cap1: number;

  @Column({
    default: 0,
    type: 'numeric',
  })
  market_cap: number; // Pool Market Cap

  // Swap related Info jsonb
  @Column({
    type: 'jsonb',
    nullable: true,
  })
  swap_info: any;

  // Liquidity related Info jsonb
  @Column({
    type: 'jsonb',
    nullable: true,
  })
  pair_mint_info: any;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

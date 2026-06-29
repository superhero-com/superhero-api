import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Pair } from './pair.entity';

@Entity({
  name: 'pair_transactions',
})
// Backs the per-pair, time-ordered history query (PairHistoryService) and the
// from_date/to_date range filter. Index name is shared with the idempotent
// bootstrap so synchronize-based and production environments converge on one
// index. Keep both in sync if you rename it.
@Index('IDX_pair_transactions_pair_created_at', ['pair', 'created_at'])
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

  @Column()
  tx_type: string;

  // Postgres `numeric` is returned as a string by the driver, and these raw
  // amounts exceed Number.MAX_SAFE_INTEGER — so they are typed as `string` and
  // written as full-precision decimal strings (never via Number/toNumber()).
  @Column({
    default: 0,
    type: 'numeric',
  })
  reserve0: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  reserve1: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  ratio0: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  ratio1: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  total_supply: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  volume0: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  volume1: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  market_cap0: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  market_cap1: string;

  @Column({
    default: 0,
    type: 'numeric',
  })
  market_cap: string; // Pool Market Cap

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

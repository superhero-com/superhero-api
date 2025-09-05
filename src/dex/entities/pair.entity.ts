import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  Column,
} from 'typeorm';
import { DexToken } from './dex-token.entity';
import { PairTransaction } from './pair-transaction.entity';

@Entity({
  name: 'pairs',
})
export class Pair {
  @PrimaryColumn()
  address: string;

  @ManyToOne(() => DexToken, (dexToken) => dexToken.address)
  @JoinColumn({ name: 'token0_address' })
  token0: DexToken;

  @ManyToOne(() => DexToken, (dexToken) => dexToken.address)
  @JoinColumn({ name: 'token1_address' })
  token1: DexToken;

  @OneToMany(() => PairTransaction, (transaction) => transaction.pair)
  transactions: PairTransaction[];

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
  total_supply: number;

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

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

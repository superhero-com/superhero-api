import { DexToken } from './dex-token.entity';
import { PairTransaction } from './pair-transaction.entity';
import {
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';

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

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

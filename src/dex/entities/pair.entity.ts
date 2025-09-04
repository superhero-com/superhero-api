import { DexToken } from './dex-token.entity';
import {
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  ManyToOne,
  JoinColumn,
  Column,
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

  @Column({
    default: 0,
  })
  transactions_count: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import { BigNumber } from 'bignumber.js';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({
  name: 'analytics',
})
export class Analytic {
  @PrimaryGeneratedColumn()
  id: string; // id

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  total_market_cap_sum: BigNumber;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  total_volume_sum: BigNumber;

  @Column()
  total_tokens: number;

  @Column()
  total_transactions: number;

  @Column()
  total_created_tokens: number;

  @Column()
  total_active_accounts: number;

  @Column({
    type: 'date',
    unique: true,
  })
  public date: Date; // date only
}

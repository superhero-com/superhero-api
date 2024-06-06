import { BigNumber } from 'bignumber.js';
import { BigNumberTransformer } from 'src/utils/BigNumberTransformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity()
export class Token {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    default: 'ae_mainnet', // || 'ae_uat'
  })
  network_id: string;

  @Column({
    nullable: true,
  })
  factory_address: string;

  @Column()
  sale_address: string;

  @Column({
    default: null,
  })
  owner_address: string;

  /**
   * Basic Token Info
   */
  @Column({
    default: null,
  })
  address: string;

  @Column()
  name: string;

  @Column()
  symbol: string;

  @Column({
    default: 18,
    type: 'bigint',
  })
  decimals: string;

  @Column({
    default: 10000,
  })
  rank: number;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  price: BigNumber;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  sell_price: BigNumber;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  market_cap: BigNumber;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  total_supply: BigNumber;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import { BigNumber } from 'bignumber.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { IPriceDto } from '../dto/price.dto';

@Entity()
export class Token {
  @PrimaryColumn()
  sale_address: string;

  @Index()
  @Column({
    default: false,
  })
  unlisted: boolean;

  @Column({
    default: 0,
  })
  last_sync_tx_count: number;

  @Column({
    default: 0,
  })
  tx_count: number;

  @Column({
    default: 0,
  })
  holders_count: number;

  @Index()
  @Column({
    nullable: true,
  })
  factory_address: string;

  @Column({
    nullable: true,
  })
  create_tx_hash: string;

  @Column({
    nullable: true,
  })
  dao_address: string;

  @Index()
  @Column({
    default: null,
  })
  creator_address: string;

  @Column({
    default: null,
  })
  beneficiary_address: string;

  @Column({
    default: null,
  })
  bonding_curve_address: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  dao_balance: BigNumber;

  @Index()
  @Column({
    default: null,
  })
  owner_address: string;

  /**
   * Basic Token Info
   */
  @Index()
  @Column({
    default: null,
  })
  address: string;

  @Index()
  @Column()
  name: string;

  @Index()
  @Column()
  symbol: string;

  @Column({
    default: 18,
    type: 'bigint',
  })
  decimals: string;

  @Column({
    nullable: true,
  })
  collection: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  price: BigNumber;

  @Column({
    type: 'json',
    nullable: true,
  })
  price_data!: IPriceDto;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  sell_price: BigNumber;

  @Column({
    type: 'json',
    nullable: true,
  })
  sell_price_data!: IPriceDto;

  @Index()
  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  market_cap: BigNumber;

  @Column({
    type: 'json',
    nullable: true,
  })
  market_cap_data!: IPriceDto;

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

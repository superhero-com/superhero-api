import { BigNumber } from 'bignumber.js';
import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { IPriceDto } from '../dto/price.dto';
import { TokenHolder } from './token-holders.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';

@Entity()
export class Token {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({
    default: false,
  })
  unlisted: boolean;

  @OneToMany(() => Transaction, (tokenTransaction) => tokenTransaction.token)
  transactions: Transaction[];

  @Column({
    default: 0,
  })
  last_sync_tx_count: number;

  @Column({
    default: 0,
  })
  tx_count: number;

  @OneToMany(() => TokenHolder, (tokenHolder) => tokenHolder.token)
  holders: TokenHolder[];

  @Column({
    default: 0,
  })
  holders_count: number;

  @Index()
  @Column({
    nullable: true,
  })
  factory_address: string;

  @Index()
  @Column({
    unique: true,
  })
  sale_address: string;

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

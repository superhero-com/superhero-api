import { BigNumber } from 'bignumber.js';
import { BigNumberTransformer } from 'src/utils/BigNumberTransformer';
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
import { Transaction } from 'src/transactions/entities/transaction.entity';

@Entity()
export class Token {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToMany(() => Transaction, (tokenTransaction) => tokenTransaction.token)
  transactions: Transaction[];

  @OneToMany(() => TokenHolder, (tokenHolder) => tokenHolder.token)
  holders: TokenHolder[];

  @Column({
    default: 0,
  })
  holders_count: number;

  @Column({
    nullable: true,
  })
  factory_address: string;

  @Column()
  sale_address: string;

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
    nullable: true,
  })
  rank: number;

  @Column({
    nullable: true,
  })
  category: string;

  @Column({
    nullable: true,
  })
  category_rank: number;

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

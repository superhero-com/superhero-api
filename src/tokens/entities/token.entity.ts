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
import { TokenHistory } from './token-history.entity';
import { TokenHolder } from './token-holders.entity';
import { TokenTransaction } from './token-transaction.entity';

@Entity()
export class Token {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToMany(
    () => TokenTransaction,
    (tokenTransaction) => tokenTransaction.token,
  )
  transactions: TokenTransaction[];

  @OneToMany(() => TokenHistory, (tokenHistory) => tokenHistory.token)
  histories: TokenHistory[];

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

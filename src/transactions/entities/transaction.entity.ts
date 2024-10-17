import BigNumber from 'bignumber.js';
import { IPriceDto } from 'src/tokens/dto/price.dto';
import { Token } from 'src/tokens/entities/token.entity';
import { BigNumberTransformer } from 'src/utils/BigNumberTransformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({
  name: 'transactions',
})
export class Transaction {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Token, (token) => token.transactions)
  token: Token;

  @Index()
  @Column()
  tx_hash: string;

  @Column()
  tx_type: string; // buy/sell/create_community

  @Column()
  block_height: number;

  @Column({
    default: false,
  })
  verified: boolean; // If this transaction is verified

  @Column()
  address: string; // Address of the user who made this transaction

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  volume: BigNumber; // Total Units was bought/sold

  @Column({
    type: 'json',
  })
  amount: IPriceDto; // Total spent/received amount

  @Column({
    type: 'json',
  })
  unit_price: IPriceDto; // Unit price of this transaction
  //
  @Column({
    type: 'json',
    nullable: true,
  })
  previous_buy_price!: IPriceDto; // Previous buy price before this transaction

  @Column({
    type: 'json',
  })
  buy_price: IPriceDto; // Buy price of this transaction

  @Column({
    type: 'json',
    nullable: true,
  })
  sell_price!: IPriceDto; // TODO: remove

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  total_supply: BigNumber; // Total supply of the token at the time of this transaction

  @Column({
    type: 'json',
    nullable: true,
  })
  market_cap!: IPriceDto; // Market cap data at the time of this transaction

  @Column({
    nullable: true,
  })
  token_rank: number; // Token rank at the time of this transaction

  @Column({
    nullable: true,
  })
  token_category_rank: number; // Token category rank at the time of this transaction

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

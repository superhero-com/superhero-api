import { IPriceDto } from '@/tokens/dto/price.dto';
import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import BigNumber from 'bignumber.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity({
  name: 'transactions',
})
@Index('IDX_TRANSACTION_SALE_ADDRESS_CREATED_AT', ['sale_address', 'created_at'])
export class Transaction {
  @Index()
  @PrimaryColumn()
  tx_hash: string;

  @Index()
  @Column()
  sale_address: string;

  @Column()
  tx_type: string; // buy/sell/create_community

  @Column()
  block_height: number;

  @Column({
    default: false,
  })
  verified: boolean; // If this transaction is verified

  @Index()
  @Column()
  address: string; // Address of the user who made this transaction

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  volume: BigNumber; // Total Units was bought/sold

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  protocol_reward: BigNumber; // Protocol reward for this transaction

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

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

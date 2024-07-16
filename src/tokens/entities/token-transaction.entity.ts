import BigNumber from 'bignumber.js';
import { BigNumberTransformer } from 'src/utils/BigNumberTransformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { IPriceDto } from '../dto/price.dto';
import { Token } from './token.entity';

@Entity({
  name: 'token_transactions',
})
export class TokenTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Token, (token) => token.transactions)
  token: Token;

  @Index()
  @Column()
  tx_hash: string;

  @Column()
  tx_type: string;

  @Column()
  address: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  volume: BigNumber;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  amount: BigNumber; // Total amount

  @Column({
    type: 'json',
    nullable: true,
  })
  amount_data: IPriceDto;

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

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

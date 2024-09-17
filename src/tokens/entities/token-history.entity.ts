import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { IPriceDto } from '../dto/price.dto';
import { BigNumberTransformer } from 'src/utils/BigNumberTransformer';
import BigNumber from 'bignumber.js';
import { Token } from './token.entity';

@Entity()
export class TokenHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Token, (token) => token.histories)
  token: Token;

  @Column({
    default: 10000,
  })
  token_rank: number;

  @Index()
  @Column({
    nullable: true,
  })
  tx_hash: string; // caused by

  @Column({
    nullable: true,
  })
  tx_type: string;

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

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  volume: BigNumber;

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

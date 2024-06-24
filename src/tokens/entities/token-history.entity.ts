import {
  Column,
  CreateDateColumn,
  Entity,
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

  @Column()
  sale_address: string;

  @Column({
    type: 'json',
    nullable: true,
  })
  price!: IPriceDto;

  @Column({
    type: 'json',
    nullable: true,
  })
  sell_price!: IPriceDto;

  @Column({
    type: 'json',
    nullable: true,
  })
  market_cap!: IPriceDto;

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
  total_supply: BigNumber;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

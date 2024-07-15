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
export class TokenHolder {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Token, (token) => token.holders)
  token: Token;

  @Column()
  address: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  balance: BigNumber;

  @Column({
    type: 'json',
    nullable: true,
  })
  balance_data: IPriceDto;

  @Column({
    default: 0,
    type: 'float',
  })
  percentage: number;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

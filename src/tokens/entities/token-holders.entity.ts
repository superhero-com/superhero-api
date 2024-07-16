import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
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

  @Index()
  @Column({
    default: 0,
    type: 'float',
  })
  percentage: number;

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

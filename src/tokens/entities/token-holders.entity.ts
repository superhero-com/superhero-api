import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import BigNumber from 'bignumber.js';
import { Token } from './token.entity';

@Entity()
export class TokenHolder {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @ManyToOne(() => Token, (token) => token.holders, {
    onDelete: 'CASCADE',
  })
  token: Token;

  @Index()
  @Column()
  address: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  balance: BigNumber;

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

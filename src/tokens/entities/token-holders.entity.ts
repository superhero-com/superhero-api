import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import BigNumber from 'bignumber.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity()
export class TokenHolder {
  @PrimaryColumn()
  id: string;

  @Index()
  @Column()
  aex9_address: string;

  @Index()
  @Column()
  address: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  balance: BigNumber;

  @Column({
    default: 0,
  })
  block_number: number;

  @Column({
    default: '',
  })
  last_tx_hash: string;

  @Index()
  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

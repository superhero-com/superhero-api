import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import BigNumber from 'bignumber.js';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// Backs the holder-count query (`aex9_address = X AND balance > 0`) run on
// every indexed buy/sell, plus the `ORDER BY balance DESC` holders listing.
// Index name is shared with the idempotent migration bootstrap so
// synchronize-based and production environments converge on one index.
@Index('IDX_TOKEN_HOLDER_AEX9_BALANCE', ['aex9_address', 'balance'])
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

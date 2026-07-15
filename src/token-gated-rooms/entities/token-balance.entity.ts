import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import { BigNumber } from 'bignumber.js';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Authoritative AEX9 balance per holder (plan §4.5). Composite PK
 * `(token_address, holder_address)`. `balance` is stored as **raw integer base
 * units** (plan §5.4; compare raw-vs-raw). `last_reconciled_at` is the cursor for
 * the rotating reconciliation sweep (Task 03). Schema only here.
 */
@Entity({ name: 'token_balance' })
export class TokenBalance {
  @PrimaryColumn()
  token_address: string;

  @PrimaryColumn()
  holder_address: string;

  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  balance: BigNumber;

  @Column({
    type: 'int',
    default: 0,
  })
  updated_height: number;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  last_reconciled_at: Date;
}

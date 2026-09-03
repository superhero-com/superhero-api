import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import BigNumber from 'bignumber.js';

@Entity({
  name: 'accounts',
})
@Index('IDX_ACCOUNTS_TOTAL_VOLUME', ['total_volume'])
export class Account {
  @PrimaryColumn()
  address: string;

  @Column({
    nullable: true,
  })
  bio: string;

  @Column({
    nullable: true,
  })
  chain_name: string;

  /** Last successful resolution. Drives the read path's staleness check. */
  @Column({
    nullable: true,
    type: 'timestamp',
  })
  chain_name_updated_at: Date;

  /**
   * Last attempt, successful or not. Orders the sweep so failures rotate out.
   * `select: false` keeps this internal bookkeeping out of the account
   * responses, which spread the entity directly.
   */
  @Column({
    nullable: true,
    type: 'timestamp',
    select: false,
  })
  chain_name_checked_at: Date;

  /**
   * Total volume of the account
   */
  @Column({
    default: 0n,
    type: 'numeric',
    transformer: BigNumberTransformer,
  })
  total_volume: BigNumber; // AE

  /**
   * Total transactions of the account
   */
  @Column({
    default: 0,
  })
  total_tx_count: number;

  @Column({
    default: 0,
  })
  total_buy_tx_count: number;

  @Column({
    default: 0,
  })
  total_sell_tx_count: number;

  @Column({
    default: 0,
  })
  total_created_tokens: number;
  /////////

  /**
   * Affiliation
   */
  @Column({
    default: 0,
  })
  total_invitation_count: number;

  @Column({
    default: 0,
  })
  total_claimed_invitation_count: number;

  @Column({
    default: 0,
  })
  total_revoked_invitation_count: number;
  //////////

  @Column({ type: 'jsonb', default: {} })
  links: Record<string, string>;

  @Column({ default: false })
  banned: boolean;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

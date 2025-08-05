import { BigNumberTransformer } from '@/utils/BigNumberTransformer';
import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import BigNumber from 'bignumber.js';

@Entity({
  name: 'accounts',
})
export class Account {
  @PrimaryColumn()
  address: string;

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

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  public created_at: Date;
}

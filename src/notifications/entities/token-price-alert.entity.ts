import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type PriceAlertDirection = 'above' | 'below';

/**
 * One-shot token price alert: "tell me when <token> goes above/below X AE".
 * Keyed by a bare `address` (no FK), like the other notification tables. Once
 * the token's price crosses the target the checker stamps `triggered_at` and
 * sends a `token-price-alert` notification; fired rows are pruned later.
 */
@Entity({ name: 'token_price_alerts' })
@Index('token_price_alerts_active_idx', ['sale_address'], {
  where: 'triggered_at IS NULL',
})
export class TokenPriceAlert {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('token_price_alerts_address_idx')
  @Column()
  address: string;

  /** Bonding-curve sale contract of the token (token.sale_address). */
  @Column()
  sale_address: string;

  @Column({ type: 'varchar', length: 8 })
  direction: PriceAlertDirection;

  /** Target price in AE per token, decimal string. */
  @Column({ type: 'numeric' })
  target_ae: string;

  @CreateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  created_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  triggered_at: Date | null;
}

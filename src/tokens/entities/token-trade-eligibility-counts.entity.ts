import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Materialized buy/sell trade count per token, incremented in
// `TransactionPersistenceService.saveTransaction` as each new transaction is
// persisted. Backs `applyListEligibilityFilters`/`getTrendingEligibilityBreakdown`
// so they no longer aggregate the full `transactions` table on every request.
@Entity({ name: 'token_trade_eligibility_counts' })
export class TokenTradeEligibilityCounts {
  @PrimaryColumn()
  sale_address: string;

  @Column({ default: 0 })
  trade_count: number;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  updated_at: Date;
}

import { EntityManager } from 'typeorm';
import { BCL_FUNCTIONS } from '@/configs';

// Shared by every transaction-save path (current and deprecated) so a token's
// trade-count eligibility is never undercounted just because a transaction
// went through the legacy route instead of TransactionPersistenceService.
export const TRADE_ELIGIBLE_TX_TYPES = new Set<string>([
  BCL_FUNCTIONS.buy,
  BCL_FUNCTIONS.sell,
]);

export async function incrementTradeEligibilityCount(
  saleAddress: string,
  manager: EntityManager,
): Promise<void> {
  await manager.query(
    `
      INSERT INTO token_trade_eligibility_counts (sale_address, trade_count, updated_at)
      VALUES ($1, 1, CURRENT_TIMESTAMP(6))
      ON CONFLICT (sale_address) DO UPDATE
      SET trade_count = token_trade_eligibility_counts.trade_count + 1,
          updated_at = CURRENT_TIMESTAMP(6)
    `,
    [saleAddress],
  );
}

// Subtracts instead of recounting: a recount's snapshot misses a trade saved
// concurrently and would overwrite its increment.
export async function decrementTradeEligibilityCount(
  saleAddress: string,
  removedTrades: number,
  manager: EntityManager,
): Promise<void> {
  await manager.query(
    `
      UPDATE token_trade_eligibility_counts
      SET trade_count = GREATEST(trade_count - $2, 0),
          updated_at = CURRENT_TIMESTAMP(6)
      WHERE sale_address = $1
    `,
    [saleAddress, removedTrades],
  );
}

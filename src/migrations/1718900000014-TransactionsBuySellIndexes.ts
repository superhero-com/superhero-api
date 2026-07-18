import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two targeted indexes for `transactions` lookups that currently
 * sequential-scan the table:
 *
 * - `IDX_TRANSACTION_SALE_ADDRESS_TX_TYPE`: general `sale_address` + `tx_type`
 *   composite, backing the `sale_address = ? AND tx_type = ?` equality lookup
 *   in `cleanupOldTransactions` (`TransactionPersistenceService` and the
 *   deprecated `TransactionService.saveTransaction`).
 * - `IDX_TRANSACTIONS_BUYSELL_ADDRESS`: partial index matching the exact
 *   `tx_type IN ('buy','sell')` predicate used by leaderboard.service.ts's
 *   `active_accounts` CTE and volume-by-address aggregate, keyed on `address`
 *   (not `sale_address`).
 *
 * An earlier draft of this migration also added a `sale_address`-scoped
 * `IDX_TRANSACTIONS_BUYSELL_SALE_ADDRESS` partial index for a token-list
 * eligibility trade-count aggregate; that aggregate was replaced by the
 * materialized `token_trade_eligibility_counts` table before this branch
 * shipped, so that index was never created here to avoid landing dead
 * write-overhead with no query to serve.
 *
 * Plain (non-CONCURRENTLY) index creation, matching this migration folder's
 * existing convention (see QueryHotPathIndexes) -- migration:run defaults to
 * `transaction: 'all'` (one batch transaction for every pending migration),
 * and CONCURRENTLY cannot run inside a transaction at all, so a per-migration
 * `transaction = false` override is rejected by TypeORM
 * (ForbiddenTransactionModeOverrideError) rather than actually skip it.
 */
export class TransactionsBuySellIndexes1718900000014 implements MigrationInterface {
  name = 'TransactionsBuySellIndexes1718900000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TRANSACTION_SALE_ADDRESS_TX_TYPE" ON "transactions" ("sale_address", "tx_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TRANSACTIONS_BUYSELL_ADDRESS" ON "transactions" ("address") WHERE tx_type IN ('buy', 'sell')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TRANSACTIONS_BUYSELL_ADDRESS"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TRANSACTION_SALE_ADDRESS_TX_TYPE"`,
    );
  }
}

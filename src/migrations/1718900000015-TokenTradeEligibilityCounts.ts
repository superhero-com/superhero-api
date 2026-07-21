import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Materializes the buy/sell trade count per token (previously an unbounded
 * `GROUP BY sale_address` aggregate over the whole `transactions` table run
 * on every token-list eligibility check, see `applyListEligibilityFilters`).
 * Backfilled once here from the current `transactions` table; kept up to
 * date going forward by an incremental upsert in
 * `TransactionPersistenceService.saveTransaction`.
 */
export class TokenTradeEligibilityCounts1718900000015 implements MigrationInterface {
  name = 'TokenTradeEligibilityCounts1718900000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "token_trade_eligibility_counts" (
        "sale_address" varchar PRIMARY KEY,
        "trade_count" integer NOT NULL DEFAULT 0,
        "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      )
    `);

    await queryRunner.query(`
      INSERT INTO "token_trade_eligibility_counts" (sale_address, trade_count, updated_at)
      SELECT
        tx.sale_address,
        COUNT(*) AS trade_count,
        CURRENT_TIMESTAMP(6)
      FROM transactions tx
      WHERE tx.tx_type IN ('buy', 'sell')
      GROUP BY tx.sale_address
      ON CONFLICT (sale_address) DO UPDATE
      SET trade_count = EXCLUDED.trade_count,
          updated_at = EXCLUDED.updated_at
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "token_trade_eligibility_counts"`,
    );
  }
}

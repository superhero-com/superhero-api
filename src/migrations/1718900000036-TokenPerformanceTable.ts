import { MigrationInterface, QueryRunner } from 'typeorm';
import { TokenPerformanceViewSinglePass1718900000027 } from './1718900000027-TokenPerformanceViewSinglePass';

/**
 * Replaces `token_performance_view` with a table: REFRESH ... CONCURRENTLY
 * rebuilt and diffed every row on each run, spilling ~1.3 GB every 5 minutes.
 * Non-CONCURRENTLY index: see migration 1718900000018.
 */
export class TokenPerformanceTable1718900000036 implements MigrationInterface {
  name = 'TokenPerformanceTable1718900000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_TRANSACTION_SALE_ADDRESS_PRICE_AE"
      ON "transactions" ("sale_address", ((buy_price->>'ae')::numeric) DESC, "created_at")
      WHERE buy_price->>'ae' IS NOT NULL AND buy_price->>'ae' <> 'NaN'
    `);
    await queryRunner.query(
      `CREATE TABLE "token_performance" ("sale_address" character varying NOT NULL, "past_24h" json, "past_7d" json, "past_30d" json, "all_time" json, CONSTRAINT "PK_37700641edc2a28bdcf0b912afc" PRIMARY KEY ("sale_address"))`,
    );
    // Seeded from the old view so the API isn't empty until the first refresh.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_matviews
          WHERE schemaname = current_schema()
            AND matviewname = 'token_performance_view'
            AND ispopulated
        ) THEN
          INSERT INTO "token_performance" ("sale_address", "past_24h", "past_7d", "past_30d", "all_time")
          SELECT "sale_address", "past_24h", "past_7d", "past_30d", "all_time"
          FROM "token_performance_view";
        END IF;
      END $$
    `);
    await queryRunner.query(
      `DROP MATERIALIZED VIEW IF EXISTS "token_performance_view"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "token_performance"`);
    await new TokenPerformanceViewSinglePass1718900000027().up(queryRunner);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_TRANSACTION_SALE_ADDRESS_PRICE_AE"`,
    );
  }
}

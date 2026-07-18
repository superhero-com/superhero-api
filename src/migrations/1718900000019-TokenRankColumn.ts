import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persists the market-cap rank (previously a live `RANK() OVER (...)` window
 * function recomputed across the whole `token` table on every list request
 * in `queryTokensWithRanks`) as a column, backfilled once here and kept
 * current by `RefreshTokenRanksService`.
 *
 * Defaults to 2147483647 (Postgres int4 max, see `UNRANKED_TOKEN_RANK` on the
 * `Token` entity), not 0: listings sort `rank ASC` (1 = highest market cap),
 * so a brand-new token would otherwise outrank every real token until the
 * next refresh cron tick.
 */
export class TokenRankColumn1718900000019 implements MigrationInterface {
  name = 'TokenRankColumn1718900000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "token"
      ADD COLUMN IF NOT EXISTS "rank" integer NOT NULL DEFAULT 2147483647
    `);

    await queryRunner.query(`
      UPDATE "token"
      SET "rank" = ranked.rank
      FROM (
        SELECT
          sale_address,
          CAST(RANK() OVER (
            ORDER BY
              CASE WHEN market_cap = 0 THEN 1 ELSE 0 END,
              market_cap DESC,
              created_at ASC
          ) AS INTEGER) AS rank
        FROM "token"
        WHERE unlisted = false
      ) ranked
      WHERE "token".sale_address = ranked.sale_address
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TOKEN_RANK" ON "token" ("rank")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_TOKEN_RANK"`);
    await queryRunner.query(`ALTER TABLE "token" DROP COLUMN IF EXISTS "rank"`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The hourly chain-name sweep ordered by `chain_name_updated_at`, which is only
 * stamped on a *successful* lookup. An address the middleware answers 404 for
 * therefore kept its NULL key and retook a head slot every hour, forever; a
 * hundred such rows starved the batch completely.
 *
 * `chain_name_checked_at` records the last attempt regardless of outcome, so
 * failures rotate to the tail. `chain_name_updated_at` keeps its "last
 * successful resolution" meaning, which the read path and the API response
 * still depend on.
 *
 * Backfilled from `chain_name_updated_at` so the first sweep after deploy is
 * not handed the whole table as an all-NULL backlog.
 */
export class AccountsChainNameCheckedAt1718900000025 implements MigrationInterface {
  name = 'AccountsChainNameCheckedAt1718900000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "chain_name_checked_at" TIMESTAMP`,
    );
    await queryRunner.query(
      `UPDATE "accounts" SET "chain_name_checked_at" = "chain_name_updated_at" WHERE "chain_name_updated_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "accounts" DROP COLUMN IF EXISTS "chain_name_checked_at"`,
    );
  }
}

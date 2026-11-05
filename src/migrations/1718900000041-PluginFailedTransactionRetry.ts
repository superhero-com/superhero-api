import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backoff state for the parked-failure retry job
 * (PluginFailedTransactionService.retryDueFailedTransactions). Existing rows
 * start at 0 attempts and no next_retry_at, so they are due on the first run.
 *
 * `IF NOT EXISTS` because `DB_SYNC=true` environments may already have the
 * columns from the entity.
 */
export class PluginFailedTransactionRetry1718900000041 implements MigrationInterface {
  name = 'PluginFailedTransactionRetry1718900000041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plugin_failed_transaction" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "plugin_failed_transaction" ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plugin_failed_transaction" DROP COLUMN IF EXISTS "next_retry_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "plugin_failed_transaction" DROP COLUMN IF EXISTS "attempts"`,
    );
  }
}

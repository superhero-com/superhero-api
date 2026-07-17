import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the home feed's token-creation source (`unlisted = false ORDER BY
 * created_at DESC`) — `token.created_at` had no covering index.
 *
 * Plain (non-CONCURRENTLY) index creation, matching this migration folder's
 * existing convention -- migration:run defaults to `transaction: 'all'`
 * (one batch transaction for every pending migration), and CONCURRENTLY
 * cannot run inside a transaction at all, so a per-migration
 * `transaction = false` override is rejected by TypeORM
 * (ForbiddenTransactionModeOverrideError) rather than actually skip it.
 */
export class TokenUnlistedCreatedAtIndex1718900000018
  implements MigrationInterface
{
  name = 'TokenUnlistedCreatedAtIndex1718900000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TOKEN_UNLISTED_CREATED_AT" ON "token" ("unlisted", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TOKEN_UNLISTED_CREATED_AT"`,
    );
  }
}

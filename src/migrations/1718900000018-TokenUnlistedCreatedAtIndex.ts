import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the home feed's token-creation source (`unlisted = false ORDER BY
 * created_at DESC`) — `token.created_at` had no covering index.
 * `CONCURRENTLY` cannot run inside a transaction, hence `transaction = false`.
 */
export class TokenUnlistedCreatedAtIndex1718900000018
  implements MigrationInterface
{
  name = 'TokenUnlistedCreatedAtIndex1718900000018';
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_TOKEN_UNLISTED_CREATED_AT" ON "token" ("unlisted", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_TOKEN_UNLISTED_CREATED_AT"`,
    );
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `FastPullTokensService.pullLatestCreatedTokens` runs
 * `DELETE FROM token WHERE dao_address IS NULL` every 10 minutes as a
 * half-created-token safety net. It matches nothing in steady state but still
 * cost a ~500ms sequential scan of `token` per tick; this partial index turns
 * that into an empty index probe. It stays near-zero size because it only
 * covers the rows the sweep is looking for.
 *
 * Plain (non-CONCURRENTLY) creation, per this folder's convention -- see
 * TokenUnlistedCreatedAtIndex1718900000018 for why CONCURRENTLY is rejected.
 */
export class TokenDaoAddressNullIndex1718900000026 implements MigrationInterface {
  name = 'TokenDaoAddressNullIndex1718900000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_token_dao_address_null" ON "token" ("dao_address") WHERE "dao_address" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_token_dao_address_null"`,
    );
  }
}

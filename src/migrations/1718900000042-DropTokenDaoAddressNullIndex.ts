import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Its only reader was the `dao_address IS NULL` delete in
 * FastPullTokensService, which is gone.
 */
export class DropTokenDaoAddressNullIndex1718900000042 implements MigrationInterface {
  name = 'DropTokenDaoAddressNullIndex1718900000042';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_token_dao_address_null"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_token_dao_address_null" ON "token" ("dao_address") WHERE "dao_address" IS NULL`,
    );
  }
}

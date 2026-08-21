import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Another entity-declared index that exists only where `synchronize` once ran
 * (same drift class PostsCreatedAtIndex1718900000022 describes). The PnL
 * trading-stats LATERAL probe plans a backward (sale_address, created_at)
 * scan per held token, so codify the index it depends on.
 */
export class TransactionsSaleAddressCreatedAtIndex1718900000023 implements MigrationInterface {
  name = 'TransactionsSaleAddressCreatedAtIndex1718900000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TRANSACTION_SALE_ADDRESS_CREATED_AT" ON "transactions" ("sale_address", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TRANSACTION_SALE_ADDRESS_CREATED_AT"`,
    );
  }
}

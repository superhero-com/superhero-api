import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Same column, operator class and collation as the primary key's unique
 * index (checked on production 2026-11-06), so the planner moves its tx_hash
 * lookups to the primary key.
 */
export class DropTransactionsTxHashDuplicateIndex1718900000043 implements MigrationInterface {
  name = 'DropTransactionsTxHashDuplicateIndex1718900000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_0deaa0ee5092d45fac99139de7"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_0deaa0ee5092d45fac99139de7" ON "transactions" ("tx_hash")`,
    );
  }
}

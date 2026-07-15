import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the single-column `IDX_pair_transactions_account_address` on
 * `pair_transactions(account_address)`. It is fully superseded by the
 * composite `IDX_pair_transactions_account_created_at`
 * (account_address, created_at) added in QueryHotPathIndexes1718900000012:
 * a btree whose leading column is `account_address` serves every lookup the
 * single-column index would, and additionally satisfies the
 * `ORDER BY created_at` of the account swap-history query in one index scan
 * (verified via EXPLAIN: Index Scan Backward, no separate sort). Keeping both
 * only doubles the write/storage overhead on this hot-insert table.
 *
 * The single-column index is not declared by any entity or migration in this
 * repo — it exists only as drift in environments that once ran `synchronize`
 * — so `IF EXISTS` makes this a safe no-op where it was never created. The
 * down() recreates it for exact reversibility.
 */
export class DropRedundantAccountAddressIndex1718900000013 implements MigrationInterface {
  name = 'DropRedundantAccountAddressIndex1718900000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_pair_transactions_account_address"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_account_address" ON "pair_transactions" ("account_address")`,
    );
  }
}

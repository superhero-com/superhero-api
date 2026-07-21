import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds indexes declared on entities (`TokenHolder`, `Tip`, `PairTransaction`)
 * that support hot query paths but were never backed by a migration -- with
 * `synchronize` off in production these never landed:
 *
 * - `IDX_TOKEN_HOLDER_AEX9_BALANCE` on `token_holder(aex9_address, balance)`:
 *   backs the holder-count query (`aex9_address = X AND balance > 0`) run on
 *   every indexed buy/sell, plus the holders listing's `ORDER BY balance`.
 * - `IDX_TIPS_SENDER_CREATED` / `IDX_TIPS_RECEIVER_CREATED` /
 *   `IDX_TIPS_POST_ID` on `tips`: the sender/receiver/post_id FK columns
 *   were never indexed at all (Postgres does not auto-index FK columns),
 *   so every tips list/summary request scanned the full table.
 * - `IDX_pair_transactions_account_created_at` on
 *   `pair_transactions(account_address, created_at)`: backs the account
 *   swap-history filter, which the existing `(pair, created_at)` index
 *   can't serve.
 *
 * `IF NOT EXISTS` (and `IF EXISTS` on the way down) because these are
 * entity-declared indexes on pre-existing, entity-managed tables: any
 * environment that ever ran with `synchronize: true` (dev/testnet, or a
 * schema the migration tests build from entities) already has them, and a
 * bare `CREATE INDEX` would fail there and block the whole migration chain.
 * On production (synchronize off) the indexes are absent and get created
 * here.
 */
export class QueryHotPathIndexes1718900000012 implements MigrationInterface {
  name = 'QueryHotPathIndexes1718900000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TOKEN_HOLDER_AEX9_BALANCE" ON "token_holder" ("aex9_address", "balance")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TIPS_SENDER_CREATED" ON "tips" ("sender_address", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TIPS_RECEIVER_CREATED" ON "tips" ("receiver_address", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TIPS_POST_ID" ON "tips" ("post_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_pair_transactions_account_created_at" ON "pair_transactions" ("account_address", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_pair_transactions_account_created_at"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_TIPS_POST_ID"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TIPS_RECEIVER_CREATED"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TIPS_SENDER_CREATED"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TOKEN_HOLDER_AEX9_BALANCE"`,
    );
  }
}

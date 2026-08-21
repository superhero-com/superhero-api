import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes `accounts(total_volume)`.
 *
 * `accounts` carried no index at all beyond its primary key -- neither an
 * entity decorator nor a migration nor the runtime DDL in
 * `dex-schema-bootstrap` ever created one. Every uncached request to the
 * accounts list endpoint therefore did a full scan plus a top-N sort, and
 * `order_by=total_volume` is the default a caller gets without asking.
 *
 * Measured at the real table size (3.5k rows, mainnet): `ORDER BY total_volume
 * DESC LIMIT 100` drops from 1.21ms to 0.055ms, and the `COUNT(*)` that
 * `paginate` issues alongside it is unchanged at ~0.29ms because it still
 * seq-scans. So this saves roughly 1.15ms per uncached request -- real, but
 * small against a 60s response cache and the surrounding request overhead.
 * The index is 128kB and `accounts` is written by batched upserts during
 * aggregate rebuilds, so it costs close to nothing to carry.
 *
 * Sizing note for whoever reads this next: the same query at 200k rows takes
 * 34.3ms unindexed versus 0.26ms indexed. This index matters when the table
 * grows, not today -- do not cite it as a current win.
 *
 * Only `total_volume` is indexed. The endpoint exposes nine sort columns, but
 * indexing all nine would multiply write cost on every aggregate rebuild for
 * sorts we have no evidence anyone uses; add the others individually if
 * telemetry shows they are hot.
 *
 * Plain (non-CONCURRENTLY) creation, matching this folder's convention --
 * migration:run defaults to `transaction: 'all'` (one batch transaction for
 * every pending migration) and CONCURRENTLY cannot run inside a transaction,
 * so a per-migration `transaction = false` override is rejected outright by
 * TypeORM (ForbiddenTransactionModeOverrideError). `IF NOT EXISTS` keeps this
 * a no-op where the index was already built out-of-band with CONCURRENTLY to
 * avoid the write-blocking SHARE lock on a large table.
 */
export class AccountsTotalVolumeIndex1718900000021 implements MigrationInterface {
  name = 'AccountsTotalVolumeIndex1718900000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ACCOUNTS_TOTAL_VOLUME" ON "accounts" ("total_volume")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_ACCOUNTS_TOTAL_VOLUME"`,
    );
  }
}

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
 * Measured on 200k rows: `ORDER BY total_volume DESC LIMIT 100` drops from a
 * parallel seq scan + top-N heapsort (34.3ms, 2794 buffers) to a plain index
 * scan (0.26ms, 103 buffers). Note the `COUNT(*)` that `paginate` issues
 * alongside it is NOT helped -- it still seq-scans at ~17ms -- so the endpoint
 * improves roughly 3x overall, not by the ratio of the sort alone.
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

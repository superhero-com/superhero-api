import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the auto-update sweep's keyset walk (see `TxPageCursor`). Drops the old
 * block_height index (a strict prefix), matched by definition because
 * `synchronize` named it with a hash. Non-CONCURRENTLY: see ...Index1718900000018.
 */
export class TxsAutoUpdateKeysetIndex1718900000028 implements MigrationInterface {
  name = 'TxsAutoUpdateKeysetIndex1718900000028';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TXS_BLOCK_HEIGHT_MICRO_TIME_HASH" ON "txs" ("block_height", "micro_time", "hash")`,
    );
    await queryRunner.query(`
      DO $$
      DECLARE redundant text;
      BEGIN
        FOR redundant IN
          SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'txs'
            AND indexdef LIKE '%(block_height)'
            AND indexdef NOT LIKE 'CREATE UNIQUE%'
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS public.%I', redundant);
        END LOOP;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_TXS_BLOCK_HEIGHT" ON "txs" ("block_height")`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_TXS_BLOCK_HEIGHT_MICRO_TIME_HASH"`,
    );
  }
}

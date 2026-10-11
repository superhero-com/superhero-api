import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsCoverage1791734400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE shorts_index_backfill
      ADD COLUMN covered_height integer NOT NULL DEFAULT -1,
      ADD COLUMN target_height integer,
      ADD COLUMN from_height integer`);
    // The old completion flag cannot prove a contiguous height range. Existing
    // installations replay once; transaction/event replacement is idempotent.
    await runner.query(
      'UPDATE shorts_index_backfill SET complete=false,cursor=null',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE shorts_index_backfill
      DROP COLUMN covered_height, DROP COLUMN target_height, DROP COLUMN from_height`);
    await runner.query(
      'UPDATE shorts_index_backfill SET complete=false,cursor=null',
    );
  }
}

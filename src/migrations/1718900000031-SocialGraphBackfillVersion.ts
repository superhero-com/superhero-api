import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records the plugin version each social-graph backfill watermark was recovered
 * at. A version bump means the decode logic changed, so the derived edge table
 * has to be rebuilt from the whole history; without this column the watermark
 * makes the backfill stop early and the older calls keep their stale decode.
 *
 * Existing rows are stamped with version 1 — the only version the plugin has
 * shipped, so any already-recovered state was recovered under it — so the first
 * boot after this lands does not read a null as a version change and re-walk the
 * whole history for nothing.
 */
export class SocialGraphBackfillVersion1718900000031 implements MigrationInterface {
  name = 'SocialGraphBackfillVersion1718900000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "social_graph_backfill_state"
         ADD COLUMN IF NOT EXISTS "version" integer`,
    );
    await queryRunner.query(
      `UPDATE "social_graph_backfill_state" SET "version" = 1 WHERE "version" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "social_graph_backfill_state" DROP COLUMN IF EXISTS "version"`,
    );
  }
}

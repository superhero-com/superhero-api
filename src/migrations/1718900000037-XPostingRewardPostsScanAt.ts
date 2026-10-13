import { MigrationInterface, QueryRunner } from 'typeorm';

// The reward tables come from docs/profile-x-rewards-manual-migration.sql, not a
// migration, so a database without them skips this (the script adds the column).
export class XPostingRewardPostsScanAt1718900000037 implements MigrationInterface {
  name = 'XPostingRewardPostsScanAt1718900000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "profile_x_posting_rewards" ADD COLUMN IF NOT EXISTS "last_posts_scan_at" timestamp`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "profile_x_posting_rewards" DROP COLUMN IF EXISTS "last_posts_scan_at"`,
    );
  }
}

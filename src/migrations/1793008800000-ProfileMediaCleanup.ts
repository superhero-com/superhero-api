import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProfileMediaCleanup1793008800000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`
      ALTER TABLE profile_media_assets
        ADD COLUMN cleanup_requested_at timestamptz,
        ADD COLUMN cleanup_blocks jsonb,
        ADD COLUMN cleanup_retry_at timestamptz,
        ADD COLUMN deleted_at timestamptz;
      ALTER TABLE profile_media_uploads ADD COLUMN source_deleted_at timestamptz;
      CREATE INDEX profile_media_assets_cleanup ON profile_media_assets(scope,cleanup_retry_at)
        WHERE cleanup_requested_at IS NOT NULL AND deleted_at IS NULL;
    `);
  }
  async down(): Promise<void> {
    throw new Error(
      'Deleted profile image bytes cannot be restored by a schema rollback',
    );
  }
}

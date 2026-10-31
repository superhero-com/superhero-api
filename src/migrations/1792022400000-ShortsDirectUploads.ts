import { MigrationInterface, QueryRunner } from 'typeorm';

/** Bounded, immutable per-part permissions; abandoned intents remain inventoried. */
export class ShortsDirectUploads1792022400000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`ALTER TABLE shorts_upload_sessions ADD COLUMN direct_parts jsonb NOT NULL DEFAULT '{}'::jsonb
      CHECK(jsonb_typeof(direct_parts)='object' AND octet_length(direct_parts::text)<=65536)`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      `LOCK TABLE shorts_upload_sessions IN ACCESS EXCLUSIVE MODE`,
    );
    await db.query(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM shorts_upload_sessions WHERE direct_parts<>'{}'::jsonb)
      THEN RAISE EXCEPTION 'Preserve direct upload references before rollback'; END IF; END $$`);
    await db.query(
      'ALTER TABLE shorts_upload_sessions DROP COLUMN direct_parts',
    );
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class PostImages1793012400000 implements MigrationInterface {
  name = 'PostImages1793012400000';

  async up(runner: QueryRunner): Promise<void> {
    for (const table of ['profile_media_uploads', 'profile_media_assets']) {
      await runner.query(
        `ALTER TABLE ${table} DROP CONSTRAINT ${table}_role_check`,
      );
      await runner.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_role_check CHECK(role IN ('avatar','cover','post'))`,
      );
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    // Refuse a rollback that would discard existing post images.
    for (const table of ['profile_media_uploads', 'profile_media_assets']) {
      await runner.query(
        `ALTER TABLE ${table} DROP CONSTRAINT ${table}_role_check`,
      );
      await runner.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_role_check CHECK(role IN ('avatar','cover'))`,
      );
    }
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsCatalog1791763211000 implements MigrationInterface {
  name = 'ShortsCatalog1791763211000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE INDEX shorts_content_public_page
      ON shorts_content(network,contract,created_at DESC,id DESC)
      WHERE body->>'publication'='published' AND body->>'moderation'='approved'`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX shorts_content_public_page');
  }
}

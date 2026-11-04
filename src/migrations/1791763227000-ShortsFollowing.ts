import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsFollowing1791763227000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE INDEX shorts_content_following_page
      ON shorts_content(network,contract,creator,created_at DESC,id DESC)
      WHERE body->>'publication'='published' AND body->>'moderation'='approved'`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX shorts_content_following_page');
  }
}

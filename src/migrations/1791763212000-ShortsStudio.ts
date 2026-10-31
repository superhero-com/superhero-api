import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsStudio1791763212000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE INDEX shorts_chain_events_video
      ON shorts_chain_events(contract,beneficiary,short_id,action,block_height)
      WHERE short_id IS NOT NULL`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX shorts_chain_events_video');
  }
}

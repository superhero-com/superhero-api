import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsSharedCutover1791763214000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE shorts_legacy_cutovers (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      fingerprint char(64) NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
      completed_at timestamptz,
      PRIMARY KEY(network,contract),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    );
    CREATE INDEX shorts_content_missing_private ON shorts_content(network,contract,id)
      WHERE body->'privateMedia' IS NULL OR body->'privateMedia'='null'::jsonb`);
  }
  async down(runner: QueryRunner): Promise<void> {
    const [row] = await runner.query(
      'SELECT 1 FROM shorts_legacy_cutovers LIMIT 1',
    );
    if (row)
      throw new Error('Preserve legacy cutover evidence before downgrade');
    await runner.query(
      'DROP INDEX shorts_content_missing_private; DROP TABLE shorts_legacy_cutovers',
    );
  }
}

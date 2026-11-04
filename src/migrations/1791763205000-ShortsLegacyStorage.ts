import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsLegacyStorage1791763205000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE shorts_storage_imports (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      kind varchar(16) NOT NULL CHECK(kind IN ('content','upload','budget')),
      id varchar(80) NOT NULL, fingerprint char(64) NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,kind,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    )`);
    // Admission history must survive expired/removed upload sessions and also
    // represents old failed preparation attempts that had their own IDs.
    const table = await runner.getTable('shorts_upload_admission');
    for (const key of table.foreignKeys)
      if (key.columnNames.includes('upload_id'))
        await runner.dropForeignKey(table, key);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Refuse a lossy rollback after legacy attempts with no session were copied.
    await runner.query(`ALTER TABLE shorts_upload_admission ADD CONSTRAINT shorts_upload_admission_session_fk
      FOREIGN KEY(network,contract,upload_id) REFERENCES shorts_upload_sessions(network,contract,id)`);
    await runner.query('DROP TABLE shorts_storage_imports');
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsUploads1791763202000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE shorts_upload_sessions (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      id varchar(80) NOT NULL, creator varchar(100) NOT NULL,
      input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),
      state varchar(16) NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','sealed','enqueued')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    )`);
    await runner.query(`CREATE TABLE shorts_upload_parts (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, upload_id varchar(80) NOT NULL,
      part integer NOT NULL CHECK(part BETWEEN 0 AND 39),
      object_ref jsonb NOT NULL CHECK(jsonb_typeof(object_ref)='object'),
      PRIMARY KEY(network,contract,upload_id,part),
      FOREIGN KEY(network,contract,upload_id) REFERENCES shorts_upload_sessions(network,contract,id)
    )`);
    await runner.query(`CREATE TABLE shorts_upload_admission (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, upload_id varchar(80) NOT NULL,
      creator varchar(100) NOT NULL, bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 41943040),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,upload_id),
      FOREIGN KEY(network,contract,upload_id) REFERENCES shorts_upload_sessions(network,contract,id)
    )`);
    await runner.query(`CREATE INDEX shorts_upload_admission_time ON shorts_upload_admission(network,contract,created_at);
      CREATE INDEX shorts_upload_sessions_expiry ON shorts_upload_sessions(network,contract,expires_at)`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE shorts_upload_admission');
    await runner.query('DROP TABLE shorts_upload_parts');
    await runner.query('DROP TABLE shorts_upload_sessions');
  }
}

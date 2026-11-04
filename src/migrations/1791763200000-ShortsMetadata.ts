import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsMetadata1791763200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE shorts_runtime (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      source_hash char(64) NOT NULL,
      legacy_hash char(64),
      max_pending integer NOT NULL CHECK(max_pending BETWEEN 1 AND 10000),
      max_creator_pending integer NOT NULL CHECK(max_creator_pending BETWEEN 1 AND max_pending),
      PRIMARY KEY(network,contract)
    )`);
    await runner.query(`CREATE TABLE shorts_content (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      id varchar(80) NOT NULL, creator varchar(100) NOT NULL,
      created_at bigint NOT NULL CHECK(created_at >= 0),
      revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
      body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      CHECK(body ?& ARRAY['id','creator'] AND body->>'id'=id AND body->>'creator'=creator)
    )`);
    await runner.query(`CREATE INDEX shorts_content_page ON shorts_content(network,contract,created_at DESC,id DESC);
      CREATE INDEX shorts_content_creator_page ON shorts_content(network,contract,creator,created_at DESC,id DESC)`);
    await runner.query(`CREATE TABLE shorts_ingestion (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      id varchar(80) NOT NULL, creator varchar(100) NOT NULL,
      input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),
      status varchar(16) NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed','cancelled')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
      fence bigint NOT NULL DEFAULT 0 CHECK(fence >= 0),
      lease_token uuid, lease_until timestamptz,
      error_code varchar(32), result_id varchar(80),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      FOREIGN KEY(network,contract,result_id) REFERENCES shorts_content(network,contract,id),
      CHECK(CASE WHEN status='processing' THEN lease_token IS NOT NULL AND lease_until IS NOT NULL
        ELSE lease_token IS NULL AND lease_until IS NULL END),
      CHECK((status='ready')=(result_id IS NOT NULL))
    )`);
    await runner.query(`CREATE INDEX shorts_ingestion_pending ON shorts_ingestion(network,contract,created_at,id)
      WHERE status IN ('queued','processing');
      CREATE INDEX shorts_ingestion_creator ON shorts_ingestion(network,contract,creator,status);
      CREATE INDEX shorts_ingestion_expired ON shorts_ingestion(network,contract,lease_until)
      WHERE status='processing'`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE shorts_ingestion');
    await runner.query('DROP TABLE shorts_content');
    await runner.query('DROP TABLE shorts_runtime');
  }
}

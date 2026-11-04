import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsStorageReferences1791763218000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE shorts_storage_reconciliations (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,id uuid NOT NULL,inventory_id uuid NOT NULL,
      after_resource varchar(80) NOT NULL DEFAULT '',complete boolean NOT NULL DEFAULT false,
      roots bigint NOT NULL DEFAULT 0 CHECK(roots>=0),reference_count bigint NOT NULL DEFAULT 0 CHECK(reference_count>=0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract,inventory_id) REFERENCES shorts_storage_inventory_runs(network,contract,id)
    );
    CREATE TABLE shorts_storage_reference_roots (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,resource_id varchar(80) NOT NULL,
      fingerprint char(64) NOT NULL,active_holds integer NOT NULL CHECK(active_holds>=0),reasons jsonb NOT NULL CHECK(jsonb_typeof(reasons)='array'),
      observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,run_id,resource_id),
      FOREIGN KEY(network,contract,run_id) REFERENCES shorts_storage_reconciliations(network,contract,id)
    );
    CREATE TABLE shorts_storage_references (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,resource_id varchar(80) NOT NULL,
      object_key varchar(512) NOT NULL,key_id varchar(32) NOT NULL,sha256 char(64) NOT NULL,bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 67108864),
      PRIMARY KEY(network,contract,run_id,resource_id,object_key),
      FOREIGN KEY(network,contract,run_id,resource_id) REFERENCES shorts_storage_reference_roots(network,contract,run_id,resource_id)
    );
    CREATE INDEX shorts_storage_references_key ON shorts_storage_references(network,contract,run_id,object_key);
    CREATE INDEX shorts_storage_inventory_object_key ON shorts_storage_inventory_objects(network,contract,run_id,object_key);`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_storage_reconciliations IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_storage_reconciliations) THEN RAISE EXCEPTION 'Preserve storage reference history before rollback'; END IF;
      DROP TABLE shorts_storage_references; DROP TABLE shorts_storage_reference_roots; DROP TABLE shorts_storage_reconciliations;
      DROP INDEX shorts_storage_inventory_object_key;
    END $rollback$`);
  }
}

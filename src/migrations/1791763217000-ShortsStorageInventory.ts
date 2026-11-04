import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsStorageInventory1791763217000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE shorts_storage_inventory_runs (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id uuid NOT NULL,
      source_hash char(64) NOT NULL, storage_id char(64) NOT NULL, object_prefix varchar(200) NOT NULL,
      page bigint NOT NULL DEFAULT 0 CHECK(page>=0), next_cursor jsonb,
      complete boolean NOT NULL DEFAULT false,
      entries bigint NOT NULL DEFAULT 0 CHECK(entries>=0), delete_markers bigint NOT NULL DEFAULT 0 CHECK(delete_markers>=0),
      stored_bytes numeric(30,0) NOT NULL DEFAULT 0 CHECK(stored_bytes>=0), current_bytes numeric(30,0) NOT NULL DEFAULT 0 CHECK(current_bytes>=0),
      created_by name NOT NULL DEFAULT current_user, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,id), FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      CHECK(next_cursor IS NULL OR jsonb_typeof(next_cursor)='object'), CHECK(NOT complete OR next_cursor IS NULL)
    );
    CREATE TABLE shorts_storage_inventory_pages (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, run_id uuid NOT NULL,
      page bigint NOT NULL CHECK(page>=0), cursor_hash char(64) NOT NULL,
      PRIMARY KEY(network,contract,run_id,page), UNIQUE(network,contract,run_id,cursor_hash),
      FOREIGN KEY(network,contract,run_id) REFERENCES shorts_storage_inventory_runs(network,contract,id)
    );
    CREATE TABLE shorts_storage_inventory_objects (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, run_id uuid NOT NULL,
      identity char(64) NOT NULL, object_key text NOT NULL CHECK(octet_length(object_key) BETWEEN 1 AND 1024),
      version_id text NOT NULL CHECK(octet_length(version_id) BETWEEN 1 AND 1024),
      deleted boolean NOT NULL, latest boolean NOT NULL,
      bytes bigint NOT NULL CHECK(bytes BETWEEN 0 AND 9007199254740991), modified_at timestamptz NOT NULL,
      PRIMARY KEY(network,contract,run_id,identity),
      FOREIGN KEY(network,contract,run_id) REFERENCES shorts_storage_inventory_runs(network,contract,id),
      CHECK(NOT deleted OR bytes=0)
    );`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_storage_inventory_runs IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_storage_inventory_runs) THEN
        RAISE EXCEPTION 'Preserve storage inventory history before rollback';
      END IF;
      DROP TABLE shorts_storage_inventory_objects;
      DROP TABLE shorts_storage_inventory_pages;
      DROP TABLE shorts_storage_inventory_runs;
    END $rollback$`);
  }
}

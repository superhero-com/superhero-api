import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsMultipartInventory1791763221000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE shorts_multipart_inventory_runs (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,id uuid NOT NULL,
      source_hash char(64) NOT NULL,storage_id char(64) NOT NULL,object_prefix varchar(200) NOT NULL,
      phase varchar(16) NOT NULL DEFAULT 'uploads' CHECK(phase IN ('uploads','parts','complete')),
      next_cursor jsonb,after_upload varchar(64) NOT NULL DEFAULT '',part_marker integer NOT NULL DEFAULT 0 CHECK(part_marker BETWEEN 0 AND 10000),
      pages bigint NOT NULL DEFAULT 0 CHECK(pages>=0),uploads bigint NOT NULL DEFAULT 0 CHECK(uploads>=0),
      examined bigint NOT NULL DEFAULT 0 CHECK(examined>=0),unavailable bigint NOT NULL DEFAULT 0 CHECK(unavailable>=0),
      parts bigint NOT NULL DEFAULT 0 CHECK(parts>=0),observed_bytes numeric(30,0) NOT NULL DEFAULT 0 CHECK(observed_bytes>=0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,id),FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract)
    );
    CREATE TABLE shorts_multipart_inventory_uploads (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,identity char(64) NOT NULL,
      object_key text NOT NULL CHECK(octet_length(object_key) BETWEEN 1 AND 1024),
      upload_id text NOT NULL CHECK(octet_length(upload_id) BETWEEN 1 AND 1024),initiated_at timestamptz NOT NULL,
      PRIMARY KEY(network,contract,run_id,identity),FOREIGN KEY(network,contract,run_id) REFERENCES shorts_multipart_inventory_runs(network,contract,id)
    );
    CREATE TABLE shorts_multipart_inventory_parts (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,upload_identity char(64) NOT NULL,
      part_number integer NOT NULL CHECK(part_number BETWEEN 1 AND 10000),bytes bigint NOT NULL CHECK(bytes BETWEEN 0 AND 9007199254740991),
      modified_at timestamptz NOT NULL,etag text NOT NULL CHECK(octet_length(etag) BETWEEN 1 AND 1024),
      PRIMARY KEY(network,contract,run_id,upload_identity,part_number),
      FOREIGN KEY(network,contract,run_id,upload_identity) REFERENCES shorts_multipart_inventory_uploads(network,contract,run_id,identity)
    );
    CREATE TABLE shorts_multipart_inventory_outcomes (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,upload_identity char(64) NOT NULL,
      unavailable boolean NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,run_id,upload_identity),
      FOREIGN KEY(network,contract,run_id,upload_identity) REFERENCES shorts_multipart_inventory_uploads(network,contract,run_id,identity)
    );
    CREATE TABLE shorts_multipart_inventory_pages (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,page bigint NOT NULL CHECK(page>=0),cursor_hash char(64) NOT NULL,
      PRIMARY KEY(network,contract,run_id,page),UNIQUE(network,contract,run_id,cursor_hash),
      FOREIGN KEY(network,contract,run_id) REFERENCES shorts_multipart_inventory_runs(network,contract,id)
    );`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_multipart_inventory_runs IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_multipart_inventory_runs) THEN RAISE EXCEPTION 'Preserve multipart inventory history before rollback'; END IF;
      DROP TABLE shorts_multipart_inventory_pages;DROP TABLE shorts_multipart_inventory_outcomes;
      DROP TABLE shorts_multipart_inventory_parts;DROP TABLE shorts_multipart_inventory_uploads;DROP TABLE shorts_multipart_inventory_runs;
    END $rollback$`);
  }
}

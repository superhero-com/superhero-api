import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsHlsInventory1791763219000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE shorts_hls_inventory_runs (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,id uuid NOT NULL,
      source_hash char(64) NOT NULL,storage_id char(64) NOT NULL,namespace varchar(64) NOT NULL,
      phase varchar(16) NOT NULL DEFAULT 'references' CHECK(phase IN ('references','index','complete')),
      after_resource varchar(80) NOT NULL DEFAULT '',redis_cursor varchar(20) NOT NULL DEFAULT '0',redis_epoch char(40),
      pages bigint NOT NULL DEFAULT 0 CHECK(pages>=0),roots bigint NOT NULL DEFAULT 0 CHECK(roots>=0),
      entries bigint NOT NULL DEFAULT 0 CHECK(entries>=0),indexed_bytes numeric(30,0) NOT NULL DEFAULT 0 CHECK(indexed_bytes>=0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,id)
    );
    CREATE TABLE shorts_hls_inventory_roots (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,resource_id varchar(80) NOT NULL,
      source_key char(64),source_cid varchar(120),active_holds integer NOT NULL CHECK(active_holds>=0),
      reasons jsonb NOT NULL CHECK(jsonb_typeof(reasons)='array'),
      PRIMARY KEY(network,contract,run_id,resource_id),
      FOREIGN KEY(network,contract,run_id) REFERENCES shorts_hls_inventory_runs(network,contract,id)
    );
    CREATE INDEX shorts_hls_inventory_source ON shorts_hls_inventory_roots(network,contract,run_id,source_key);
    CREATE TABLE shorts_hls_inventory_entries (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,source_key char(64) NOT NULL,
      cid varchar(120) NOT NULL,metadata_hash char(64) NOT NULL,bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 100000000),
      files jsonb NOT NULL CHECK(jsonb_typeof(files)='array' AND jsonb_array_length(files) BETWEEN 3 AND 34),
      PRIMARY KEY(network,contract,run_id,source_key),
      FOREIGN KEY(network,contract,run_id) REFERENCES shorts_hls_inventory_runs(network,contract,id)
    );
    CREATE INDEX shorts_hls_inventory_cid ON shorts_hls_inventory_entries(network,contract,run_id,cid);
    CREATE TABLE shorts_hls_inventory_pages (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,cursor varchar(20) NOT NULL,
      PRIMARY KEY(network,contract,run_id,cursor),
      FOREIGN KEY(network,contract,run_id) REFERENCES shorts_hls_inventory_runs(network,contract,id)
    );`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_hls_inventory_runs IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_hls_inventory_runs) THEN RAISE EXCEPTION 'Preserve HLS inventory history before rollback'; END IF;
      DROP TABLE shorts_hls_inventory_pages;DROP TABLE shorts_hls_inventory_entries;DROP TABLE shorts_hls_inventory_roots;DROP TABLE shorts_hls_inventory_runs;
    END $rollback$`);
  }
}

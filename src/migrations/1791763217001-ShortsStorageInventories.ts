import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

export class ShortsStorageInventories1791763217001 extends FeatureMigration {
  readonly steps = {
    ShortsStorageInventory: {
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
      },
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
      },
    },

    ShortsStorageReferences: {
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
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_storage_reconciliations IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_storage_reconciliations) THEN RAISE EXCEPTION 'Preserve storage reference history before rollback'; END IF;
      DROP TABLE shorts_storage_references; DROP TABLE shorts_storage_reference_roots; DROP TABLE shorts_storage_reconciliations;
      DROP INDEX shorts_storage_inventory_object_key;
    END $rollback$`);
      },
    },

    ShortsHlsInventory: {
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
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_hls_inventory_runs IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_hls_inventory_runs) THEN RAISE EXCEPTION 'Preserve HLS inventory history before rollback'; END IF;
      DROP TABLE shorts_hls_inventory_pages;DROP TABLE shorts_hls_inventory_entries;DROP TABLE shorts_hls_inventory_roots;DROP TABLE shorts_hls_inventory_runs;
    END $rollback$`);
      },
    },

    ShortsPinInventory: {
      async up(db: QueryRunner): Promise<void> {
        await db.query(`CREATE TABLE shorts_pin_inventory_runs (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,id uuid NOT NULL,
      source_hash char(64) NOT NULL,storage_id char(64) NOT NULL,peer_id varchar(120) NOT NULL,hls_run uuid NOT NULL,
      phase varchar(16) NOT NULL DEFAULT 'incomplete' CHECK(phase IN ('incomplete','complete')),
      pins bigint NOT NULL DEFAULT 0 CHECK(pins>=0),batches bigint NOT NULL DEFAULT 0 CHECK(batches>=0),
      capacity_before jsonb,capacity_after jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract,hls_run) REFERENCES shorts_hls_inventory_runs(network,contract,id)
    );
    CREATE TABLE shorts_pin_inventory_entries (
      network varchar(32) NOT NULL,contract varchar(100) NOT NULL,run_id uuid NOT NULL,
      cid varchar(120) NOT NULL,type varchar(16) NOT NULL CHECK(type IN ('recursive','direct')),
      PRIMARY KEY(network,contract,run_id,cid,type),
      FOREIGN KEY(network,contract,run_id) REFERENCES shorts_pin_inventory_runs(network,contract,id)
    );`);
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_pin_inventory_runs IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_pin_inventory_runs) THEN RAISE EXCEPTION 'Preserve IPFS inventory history before rollback'; END IF;
      DROP TABLE shorts_pin_inventory_entries;DROP TABLE shorts_pin_inventory_runs;
    END $rollback$`);
      },
    },

    ShortsMultipartInventory: {
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
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_multipart_inventory_runs IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_multipart_inventory_runs) THEN RAISE EXCEPTION 'Preserve multipart inventory history before rollback'; END IF;
      DROP TABLE shorts_multipart_inventory_pages;DROP TABLE shorts_multipart_inventory_outcomes;
      DROP TABLE shorts_multipart_inventory_parts;DROP TABLE shorts_multipart_inventory_uploads;DROP TABLE shorts_multipart_inventory_runs;
    END $rollback$`);
      },
    },
  };
}

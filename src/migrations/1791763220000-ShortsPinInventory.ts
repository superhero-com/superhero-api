import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsPinInventory1791763220000 implements MigrationInterface {
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
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_pin_inventory_runs IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_pin_inventory_runs) THEN RAISE EXCEPTION 'Preserve IPFS inventory history before rollback'; END IF;
      DROP TABLE shorts_pin_inventory_entries;DROP TABLE shorts_pin_inventory_runs;
    END $rollback$`);
  }
}

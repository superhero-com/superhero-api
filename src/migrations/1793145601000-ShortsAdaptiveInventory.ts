import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsAdaptiveInventory1793145601000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`
      ALTER TABLE shorts_hls_inventory_runs ADD COLUMN reference_version smallint NOT NULL DEFAULT 1
        CHECK(reference_version IN (1,2,3,4,5));
      ALTER TABLE shorts_hls_inventory_roots ADD COLUMN pins jsonb NOT NULL DEFAULT '[]'
        CHECK(jsonb_typeof(pins)='array' AND jsonb_array_length(pins)<=64);
      CREATE INDEX shorts_hls_inventory_root_pins ON shorts_hls_inventory_roots USING gin(pins jsonb_path_ops);
      ALTER TABLE shorts_hls_inventory_entries ADD COLUMN version smallint NOT NULL DEFAULT 2 CHECK(version IN (2,3));
      ALTER TABLE shorts_hls_inventory_entries DROP CONSTRAINT shorts_hls_inventory_entries_bytes_check;
      ALTER TABLE shorts_hls_inventory_entries DROP CONSTRAINT shorts_hls_inventory_entries_files_check;
      ALTER TABLE shorts_hls_inventory_entries ADD CONSTRAINT shorts_hls_inventory_entries_bytes_check
        CHECK(bytes BETWEEN 1 AND CASE WHEN version=3 THEN 201326592 ELSE 100000000 END);
      ALTER TABLE shorts_hls_inventory_entries ADD CONSTRAINT shorts_hls_inventory_entries_files_check
        CHECK(jsonb_typeof(files)='array' AND jsonb_array_length(files) BETWEEN 3 AND CASE WHEN version=3 THEN 256 ELSE 34 END);
    `);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(`DO $rollback$ BEGIN
      LOCK TABLE shorts_hls_inventory_runs,shorts_hls_inventory_roots,shorts_hls_inventory_entries IN ACCESS EXCLUSIVE MODE;
      IF EXISTS(SELECT 1 FROM shorts_hls_inventory_runs WHERE reference_version>=2)
        OR EXISTS(SELECT 1 FROM shorts_hls_inventory_roots WHERE pins<>'[]'::jsonb)
        OR EXISTS(SELECT 1 FROM shorts_hls_inventory_entries WHERE version=3) THEN
        RAISE EXCEPTION 'Preserve adaptive inventory history before rollback';
      END IF;
      ALTER TABLE shorts_hls_inventory_entries DROP CONSTRAINT shorts_hls_inventory_entries_bytes_check;
      ALTER TABLE shorts_hls_inventory_entries DROP CONSTRAINT shorts_hls_inventory_entries_files_check;
      ALTER TABLE shorts_hls_inventory_entries ADD CONSTRAINT shorts_hls_inventory_entries_bytes_check CHECK(bytes BETWEEN 1 AND 100000000);
      ALTER TABLE shorts_hls_inventory_entries ADD CONSTRAINT shorts_hls_inventory_entries_files_check
        CHECK(jsonb_typeof(files)='array' AND jsonb_array_length(files) BETWEEN 3 AND 34);
      ALTER TABLE shorts_hls_inventory_entries DROP COLUMN version;
      ALTER TABLE shorts_hls_inventory_roots DROP COLUMN pins;
      ALTER TABLE shorts_hls_inventory_runs DROP COLUMN reference_version;
    END $rollback$`);
  }
}

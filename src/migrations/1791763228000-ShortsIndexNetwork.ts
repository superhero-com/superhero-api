import { MigrationInterface, QueryRunner } from 'typeorm';

/** The shared chain index is dedicated to one network, even across releases. */
export class ShortsIndexNetwork1791763228000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`CREATE TABLE shorts_index_network (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      network text NOT NULL CHECK(network IN ('ae_uat','ae_mainnet')),
      anchor_height integer,
      anchor_hash text,
      bound_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((anchor_height IS NULL AND anchor_hash IS NULL) OR
        (anchor_height IS NOT NULL AND anchor_height > 0 AND anchor_hash IS NOT NULL))
    )`);
    await db.query(`CREATE FUNCTION shorts_index_network_immutable() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Shorts index network binding is immutable; use a separate database for another network';
      END $$`);
    await db.query(`CREATE TRIGGER shorts_index_network_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON shorts_index_network
      FOR EACH STATEMENT EXECUTE FUNCTION shorts_index_network_immutable()`);
  }

  async down(db: QueryRunner): Promise<void> {
    await db.query('LOCK TABLE shorts_index_network IN EXCLUSIVE MODE');
    await db.query(`DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM shorts_index_network) THEN
        RAISE EXCEPTION 'Cannot remove a bound Shorts index network';
      END IF;
    END $$`);
    await db.query('DROP TABLE shorts_index_network');
    await db.query('DROP FUNCTION shorts_index_network_immutable()');
  }
}

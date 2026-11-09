import { QueryRunner } from 'typeorm';
import { FeatureMigration } from './support/feature-migration';

export class ShortsChainIndexing1791676800001 extends FeatureMigration {
  readonly changes = {
    ShortsChainIndex1791676800000: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`CREATE TABLE shorts_chain_events (
      contract text NOT NULL, tx_hash varchar NOT NULL REFERENCES txs(hash) ON DELETE CASCADE,
      log_index integer NOT NULL, block_height integer NOT NULL, at bigint NOT NULL,
      action text NOT NULL, actor text NOT NULL, beneficiary text NOT NULL,
      amount numeric(78,0) NOT NULL CHECK (amount >= 0), short_id text,
      PRIMARY KEY (contract, tx_hash, log_index)
    )`);
        await runner.query(
          'CREATE INDEX shorts_chain_events_creator ON shorts_chain_events (beneficiary, contract, at DESC)',
        );
        await runner.query(
          'CREATE INDEX shorts_chain_events_tx ON shorts_chain_events (tx_hash)',
        );
        await runner.query(
          "CREATE INDEX shorts_indexed_txs ON txs (hash) WHERE data ? 'shorts'",
        );
        await runner.query(`CREATE TABLE shorts_index_backfill (
      contract text PRIMARY KEY, version integer NOT NULL, cursor text,
      complete boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
    )`);
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query('DROP INDEX shorts_indexed_txs');
        await runner.query('DROP TABLE shorts_index_backfill');
        await runner.query('DROP TABLE shorts_chain_events');
      },
    },

    ShortsCoverage1791734400000: {
      async up(runner: QueryRunner): Promise<void> {
        await runner.query(`ALTER TABLE shorts_index_backfill
      ADD COLUMN covered_height integer NOT NULL DEFAULT -1,
      ADD COLUMN target_height integer,
      ADD COLUMN from_height integer`);
        // The old completion flag cannot prove a contiguous height range. Existing
        // installations replay once; transaction/event replacement is idempotent.
        await runner.query(
          'UPDATE shorts_index_backfill SET complete=false,cursor=null',
        );
      },
      async down(runner: QueryRunner): Promise<void> {
        await runner.query(`ALTER TABLE shorts_index_backfill
      DROP COLUMN covered_height, DROP COLUMN target_height, DROP COLUMN from_height`);
        await runner.query(
          'UPDATE shorts_index_backfill SET complete=false,cursor=null',
        );
      },
    },

    /** The shared chain index is dedicated to one network, even across releases. */
    ShortsIndexNetwork1791763228000: {
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
      },
      async down(db: QueryRunner): Promise<void> {
        await db.query('LOCK TABLE shorts_index_network IN EXCLUSIVE MODE');
        await db.query(`DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM shorts_index_network) THEN
        RAISE EXCEPTION 'Cannot remove a bound Shorts index network';
      END IF;
    END $$`);
        await db.query('DROP TABLE shorts_index_network');
        await db.query('DROP FUNCTION shorts_index_network_immutable()');
      },
    },
  };
}

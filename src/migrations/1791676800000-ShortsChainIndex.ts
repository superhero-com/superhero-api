import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsChainIndex1791676800000 implements MigrationInterface {
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
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX shorts_indexed_txs');
    await runner.query('DROP TABLE shorts_index_backfill');
    await runner.query('DROP TABLE shorts_chain_events');
  }
}

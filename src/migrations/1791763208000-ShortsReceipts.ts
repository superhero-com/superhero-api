import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsReceipts1791763208000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE shorts_receipt_scopes (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      previous_contract varchar(100), legacy_hash char(64),
      PRIMARY KEY(network,contract),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      CHECK(previous_contract IS NULL OR previous_contract<>contract)
    )`);
    await runner.query(`CREATE TABLE shorts_transaction_receipts (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      tx varchar(100) NOT NULL, actor varchar(100) NOT NULL, action varchar(64) NOT NULL,
      at bigint NOT NULL CHECK(at>=0), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      verification varchar(16) NOT NULL CHECK(verification IN ('legacy','submitted','node_observed')),
      called_contract varchar(100), block_hash varchar(100), block_height bigint,
      PRIMARY KEY(network,contract,tx),
      FOREIGN KEY(network,contract) REFERENCES shorts_receipt_scopes(network,contract),
      CHECK((verification='legacy' AND called_contract IS NULL AND block_hash IS NULL AND block_height IS NULL)
        OR (verification='submitted' AND called_contract IS NOT NULL AND block_hash IS NULL AND block_height IS NULL)
        OR (verification='node_observed' AND called_contract IS NOT NULL AND block_hash IS NOT NULL AND block_height IS NOT NULL AND block_height>=0))
    )`);
    await runner.query(`CREATE INDEX shorts_receipts_actor_page
      ON shorts_transaction_receipts(network,contract,actor,at DESC,tx DESC)`);
  }
  async down(runner: QueryRunner): Promise<void> {
    const [{ n }] = await runner.query(
      'SELECT count(*)::integer AS n FROM shorts_receipt_scopes',
    );
    if (n)
      throw new Error(
        'Restore/reconcile transaction history before removing its schema',
      );
    await runner.query('DROP TABLE shorts_transaction_receipts');
    await runner.query('DROP TABLE shorts_receipt_scopes');
  }
}

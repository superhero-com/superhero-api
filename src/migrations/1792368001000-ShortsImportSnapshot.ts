import { MigrationInterface, QueryRunner } from 'typeorm';

/** Immutable content-count baseline for a legacy import; rewards stay on each source. */
export class ShortsImportSnapshot1792368001000 implements MigrationInterface {
  async up(db: QueryRunner): Promise<void> {
    await db.query(`ALTER TABLE shorts_receipt_scopes ADD COLUMN reward_contracts text[] NOT NULL DEFAULT '{}';
      CREATE TABLE shorts_import_snapshots (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      source varchar(100) NOT NULL, cutoff_hash varchar(100) NOT NULL,
      cutoff_height bigint NOT NULL CHECK(cutoff_height>=0), digest char(64) NOT NULL,
      videos bigint NOT NULL CHECK(videos>=0), likes bigint NOT NULL CHECK(likes>=0),
      PRIMARY KEY(network,contract), FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract));
      CREATE TABLE shorts_import_videos (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      likes bigint NOT NULL CHECK(likes>=0), withdrawn boolean NOT NULL,
      PRIMARY KEY(network,contract,id), FOREIGN KEY(network,contract) REFERENCES shorts_import_snapshots(network,contract))`);
  }
  async down(db: QueryRunner): Promise<void> {
    await db.query(
      'DROP TABLE shorts_import_videos; DROP TABLE shorts_import_snapshots; ALTER TABLE shorts_receipt_scopes DROP COLUMN reward_contracts',
    );
  }
}

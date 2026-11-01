import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShortsPublications1791763209000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE shorts_publishing_accounts (
      network varchar(32) NOT NULL, operator varchar(100) NOT NULL,
      policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
      paused boolean NOT NULL DEFAULT false,
      PRIMARY KEY(network,operator)
    )`);
    await runner.query(`CREATE TABLE shorts_publishing_contracts (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL,
      operator varchar(100) NOT NULL, source_hash char(64) NOT NULL,
      PRIMARY KEY(network,contract), UNIQUE(network,contract,operator),
      FOREIGN KEY(network,contract) REFERENCES shorts_runtime(network,contract),
      FOREIGN KEY(network,operator) REFERENCES shorts_publishing_accounts(network,operator)
    )`);
    await runner.query(`CREATE TABLE shorts_publication_jobs (
      network varchar(32) NOT NULL, contract varchar(100) NOT NULL, id varchar(80) NOT NULL,
      operator varchar(100) NOT NULL, creator varchar(100) NOT NULL, intent jsonb NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','claimed','signed','confirmed','reverted','cancelled','reconciled')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), lease_token uuid, lease_until timestamptz,
      raw_tx text CHECK(octet_length(raw_tx)<=32768), tx_hash varchar(100),
      nonce bigint CHECK(nonce>0), ttl bigint CHECK(ttl>0), signed_at timestamptz,
      reserved_cost numeric(78,0) CHECK(reserved_cost>0),
      broadcast_attempts integer NOT NULL DEFAULT 0 CHECK(broadcast_attempts>=0),
      last_broadcast_at timestamptz, broadcast_blocked boolean NOT NULL DEFAULT false,
      block_hash varchar(100), block_height bigint CHECK(block_height>=0),
      PRIMARY KEY(network,contract,id),
      FOREIGN KEY(network,contract,operator) REFERENCES shorts_publishing_contracts(network,contract,operator),
      FOREIGN KEY(network,contract,id) REFERENCES shorts_content(network,contract,id),
      CHECK(jsonb_typeof(intent)='object' AND intent ?& ARRAY['id','creator','cid','bytes']
        AND intent->>'id'=id AND intent->>'creator'=creator),
      CHECK((lease_token IS NULL)=(lease_until IS NULL)),
      CHECK(status IN ('claimed','signed') OR lease_token IS NULL),
      CHECK((status='claimed')=(lease_token IS NOT NULL AND raw_tx IS NULL)),
      CHECK(CASE WHEN status IN ('signed','confirmed','reverted') THEN
        raw_tx IS NOT NULL AND tx_hash IS NOT NULL AND nonce IS NOT NULL AND ttl IS NOT NULL
        AND signed_at IS NOT NULL AND reserved_cost IS NOT NULL
        ELSE raw_tx IS NULL AND tx_hash IS NULL AND nonce IS NULL AND ttl IS NULL
        AND signed_at IS NULL AND reserved_cost IS NULL END),
      CHECK(CASE WHEN status IN ('confirmed','reverted','reconciled') THEN block_hash IS NOT NULL AND block_height IS NOT NULL
        ELSE block_hash IS NULL AND block_height IS NULL END)
    )`);
    await runner.query(`CREATE UNIQUE INDEX shorts_publication_active_account
      ON shorts_publication_jobs(network,operator) WHERE status IN ('claimed','signed');
      CREATE UNIQUE INDEX shorts_publication_nonce ON shorts_publication_jobs(network,operator,nonce) WHERE nonce IS NOT NULL;
      CREATE UNIQUE INDEX shorts_publication_hash ON shorts_publication_jobs(network,tx_hash) WHERE tx_hash IS NOT NULL;
      CREATE INDEX shorts_publication_queue ON shorts_publication_jobs(network,operator,created_at,id) WHERE status='queued';
      CREATE INDEX shorts_publication_budget ON shorts_publication_jobs(network,operator,signed_at) WHERE signed_at IS NOT NULL`);
  }
  async down(runner: QueryRunner): Promise<void> {
    const [{ n }] = await runner.query(
      'SELECT count(*)::integer AS n FROM shorts_publishing_accounts',
    );
    if (n)
      throw new Error(
        'Reconcile and preserve the signed publication journal before rollback',
      );
    await runner.query('DROP TABLE shorts_publication_jobs');
    await runner.query('DROP TABLE shorts_publishing_contracts');
    await runner.query('DROP TABLE shorts_publishing_accounts');
  }
}

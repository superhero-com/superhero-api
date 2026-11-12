import { MigrationInterface, QueryRunner } from 'typeorm';

async function updateBoundary(runner: QueryRunner, reverse: boolean) {
  const [{ schema, definition }] = await runner.query(
    "SELECT current_schema() AS schema, pg_get_functiondef('shorts_publication(text,jsonb)'::regprocedure) AS definition",
  );
  const s = '"' + schema.replaceAll('"', '""') + '"';
  const expire = `ELSIF action='expire' THEN
        IF job.status<>'signed' OR job.tx_hash IS DISTINCT FROM payload->>'transactionHash'
          OR (payload->>'accountNonce') IS DISTINCT FROM (job.nonce-1)::text
          OR coalesce(payload->>'height','') !~ '^[0-9]{1,15}$'
          OR coalesce(payload->>'tipHeight','') !~ '^[0-9]{1,15}$'
          OR coalesce(payload->>'blockHash','') !~ '^kh_[a-zA-Z0-9]{1,97}$' THEN
          RAISE EXCEPTION 'Invalid publication expiry proof' USING ERRCODE='SH400';
        END IF;
        IF (payload->>'height')::bigint<=job.ttl OR (payload->>'tipHeight')::bigint-(payload->>'height')::bigint<(account.policy->>'confirmations')::integer THEN
          RAISE EXCEPTION 'Insufficient publication expiry depth' USING ERRCODE='SH409';
        END IF;
        UPDATE ${s}.shorts_publication_jobs SET status='cancelled',
          expiry_block_hash=payload->>'blockHash', expiry_height=(payload->>'height')::bigint, expiry_tip_height=(payload->>'tipHeight')::bigint,
          lease_token=NULL,lease_until=NULL,lease_principal=NULL,updated_at=clock_timestamp()
          WHERE network=job.network AND contract=job.contract AND id=job.id AND lease_until>clock_timestamp();
      `;
  const nonceFloor = "nonce - CASE WHEN status='cancelled' THEN 1 ELSE 0 END";
  const journal = `${s}.shorts_publication_jobs WHERE network=binding.network AND operator=binding.operator`;
  const statusFields =
    "'id',job.id,'status',job.status,'transactionHash',job.tx_hash,'blockHash',job.block_hash,'height',job.block_height";
  const edits = [
    [
      "'release','settle','reconcile')",
      "'release','settle','reconcile','expire')",
      2,
    ] as const,
    [
      `SELECT nonce INTO current_nonce FROM ${journal}
          AND nonce IS NOT NULL ORDER BY nonce DESC LIMIT 1`,
      `SELECT max(${nonceFloor}) INTO current_nonce FROM ${journal} AND nonce IS NOT NULL`,
      1,
    ] as const,
    [
      `${statusFields});`,
      `${statusFields}) || jsonb_strip_nulls(jsonb_build_object('expiryBlockHash',job.expiry_block_hash,'expiryHeight',job.expiry_height));`,
      2,
    ] as const,
    [
      "ELSIF action='settle' THEN",
      expire + "ELSIF action='settle' THEN",
      1,
    ] as const,
  ];
  let sql: string = definition;
  for (const [old, next, count] of edits) {
    const [from, to] = reverse ? [next, old] : [old, next];
    if (sql.split(from).length !== count + 1)
      throw new Error('Unexpected Shorts publication boundary definition');
    sql = sql.replaceAll(from, () => to);
  }
  await runner.query(sql);
}

// Keep the exact bytes, unique hash and rolling cost on the original job. A
// proven expiration releases only the active account and its unused nonce.
async function updateJournal(runner: QueryRunner, expiry: boolean) {
  const [check] = await runner.query(`SELECT conname FROM pg_constraint
    WHERE conrelid='shorts_publication_jobs'::regclass AND contype='c'
    AND (SELECT attnum FROM pg_attribute WHERE attrelid=conrelid AND attname='signed_at')=ANY(conkey)`);
  const name = '"' + check.conname.replaceAll('"', '""') + '"';
  await runner.query(`ALTER TABLE shorts_publication_jobs DROP CONSTRAINT ${name},
    ADD CONSTRAINT ${name} CHECK(CASE WHEN status IN ('signed','confirmed','reverted')
      ${expiry ? 'OR expiry_block_hash IS NOT NULL' : ''} THEN
        raw_tx IS NOT NULL AND tx_hash IS NOT NULL AND nonce IS NOT NULL AND ttl IS NOT NULL
        AND signed_at IS NOT NULL AND reserved_cost IS NOT NULL
      ELSE raw_tx IS NULL AND tx_hash IS NULL AND nonce IS NULL AND ttl IS NULL
        AND signed_at IS NULL AND reserved_cost IS NULL END)`);
  await runner.query('DROP INDEX shorts_publication_nonce');
  await runner.query(`CREATE UNIQUE INDEX shorts_publication_nonce ON shorts_publication_jobs(network,operator,nonce)
    WHERE nonce IS NOT NULL ${expiry ? "AND status<>'cancelled'" : ''}`);
}

export class ShortsPublicationExpiry1794441600000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    await runner.query(`ALTER TABLE shorts_publication_jobs ADD COLUMN expiry_block_hash varchar(100),
      ADD COLUMN expiry_height bigint, ADD COLUMN expiry_tip_height bigint,
      ADD CHECK ((expiry_block_hash IS NULL)=(expiry_height IS NULL)),
      ADD CHECK ((expiry_block_hash IS NULL)=(expiry_tip_height IS NULL)),
      ADD CHECK (expiry_block_hash IS NULL OR
        (status='cancelled' AND expiry_block_hash ~ '^kh_[a-zA-Z0-9]{1,97}$' AND expiry_height>ttl AND expiry_tip_height>=expiry_height))`);
    await updateJournal(runner, true);
    await runner.query(`CREATE INDEX shorts_publication_nonce_floor ON shorts_publication_jobs
      (network,operator,(nonce - CASE WHEN status='cancelled' THEN 1 ELSE 0 END)) WHERE nonce IS NOT NULL`);
    await updateBoundary(runner, false);
  }

  async down(runner: QueryRunner) {
    await runner.query(
      'LOCK TABLE shorts_publication_jobs IN ACCESS EXCLUSIVE MODE',
    );
    const rows = await runner.query(
      'SELECT 1 FROM shorts_publication_jobs WHERE expiry_block_hash IS NOT NULL LIMIT 1',
    );
    if (rows.length)
      throw new Error('Cannot discard journaled publication expiry evidence');
    await updateBoundary(runner, true);
    await runner.query('DROP INDEX shorts_publication_nonce_floor');
    await updateJournal(runner, false);
    await runner.query(
      'ALTER TABLE shorts_publication_jobs DROP COLUMN expiry_block_hash, DROP COLUMN expiry_height, DROP COLUMN expiry_tip_height',
    );
  }
}

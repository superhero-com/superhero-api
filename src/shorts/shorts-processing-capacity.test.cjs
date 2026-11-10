const {
  ShortsWorkerBackpressure,
  ShortsMetadata,
  ShortsWorkers,
  ShortsWorkerAuthority,
  ShortsProcessingCapacity,
} = require('./testing/schema-migrations.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { WorkerRpc } = require('../../test/shorts/worker-rpc');
const { workerRole } = require('./testing/worker-role.cjs');
test('PostgreSQL processing capacity applies to restricted workers and legacy claims', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 20000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = `shorts_capacity_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 10 },
    migrations: [ShortsMetadata, ShortsWorkers, ShortsWorkerAuthority, ShortsProcessingCapacity] };
  const owner = new DataSource(options); await owner.initialize(); await owner.runMigrations({ transaction: 'all' });
  await new ShortsWorkerBackpressure().up(owner);
  const identities = [], clients = []; const metadata = new ShortsMetadataService(owner); const hash = 'a'.repeat(64);
  t.after(async () => {
    for (const db of clients) await db.destroy(); await owner.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    for (const identity of identities) await identity.dispose(); await admin.destroy();
  });
  async function fixture(limit = 2, count = 12) {
    const scope = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` };
    await metadata.initialize(scope, hash, 30, 30);
    await owner.query('UPDATE shorts_runtime SET max_processing=$3 WHERE network=$1 AND contract=$2', [scope.network, scope.contract, limit]);
    const workers = [];
    for (let i = 0; i < 2; i++) {
      const identity = await workerRole(admin, { url: url.href, schema, scope }); identities.push(identity);
      const db = new DataSource({ ...options, url: identity.url, migrations: [] }); await db.initialize(); clients.push(db);
      workers.push({ db, repo: new WorkerRpc(db, { scope, sourceHash: hash, leaseMs: 120000 }) });
    }
    for (let i = 0; i < count; i++) {
      const id = `job${i}`;
      const key = `shorts-private-v1/${hash}/${id}/source-manifest/key1/${hash}`;
      await metadata.enqueue(scope, id, 'ak_creator', {
        processingProfile: 'original-h264-v1', acceptedMaxBytes: 100000000,
        objectKey: key, manifest: { key, keyId: 'key1', bytes: 100, sha256: hash },
        sha256: hash, bytes: 100, title: 'Owned fixture', topic: 'Art', details: {},
      });
    }
    return { scope, workers, active: async () => Number((await owner.query(`SELECT count(*) FROM shorts_ingestion
      WHERE network=$1 AND contract=$2 AND status='processing' AND lease_until>clock_timestamp()`, [scope.network, scope.contract]))[0].count) };
  }
  await t.test('simultaneous mixed claims share the ceiling and refused work consumes no attempt', async () => {
    const f = await fixture(); const successful = [];
    const claims = await Promise.all(Array.from({ length: 30 }, async (_, i) => {
      const repo = i % 3 === 0 ? metadata : f.workers[i % 2].repo;
      const job = await repo.claim(f.scope); if (job) successful.push({ repo, job }); return job;
    }));
    assert.ok(claims.filter(Boolean).length > 0 && successful.length <= 2);
    while (successful.length < 2) { const job = await metadata.claim(f.scope); assert.ok(job); successful.push({ repo: metadata, job }); }
    assert.equal(await f.active(), 2);
    assert.equal(await f.workers[0].repo.claim(f.scope), undefined);
    const counts = await owner.query('SELECT status,attempts,count(*) FROM shorts_ingestion WHERE contract=$1 GROUP BY status,attempts', [f.scope.contract]);
    assert.equal(Number(counts.find(row => row.status === 'queued' && row.attempts === 0).count), 10);
    assert.equal(await successful[0].repo.fail(f.scope, successful[0].job), true);
    assert.ok(await f.workers[0].repo.claim(f.scope)); assert.equal(await f.active(), 2);
    for (const { db } of f.workers) await assert.rejects(db.query('UPDATE shorts_runtime SET max_processing=32'), { code: '42501' });
  });
  await t.test('namespace contention returns promptly without locking an unrelated deployment', async () => {
    const f = await fixture(1), other = await fixture(1, 1);
    const runner = owner.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    try {
      await runner.query("SELECT pg_advisory_xact_lock(hashtextextended('shorts:processing:'||$1||':'||$2,0))", [f.scope.network, f.scope.contract]);
      const started = Date.now(); assert.equal(await f.workers[0].repo.claim(f.scope), undefined);
      assert.ok(Date.now() - started < 1000); assert.ok(await other.workers[0].repo.claim(other.scope));
    } finally { await runner.rollbackTransaction(); await runner.release(); }
    assert.ok(await f.workers[0].repo.claim(f.scope));
  });
  await t.test('expiry releases capacity; renewal and stale acknowledgements cannot increase it', async () => {
    const f = await fixture(1); const [a, b] = f.workers;
    const old = await a.repo.claim(f.scope); assert.ok(old);
    assert.equal(await a.repo.heartbeat(f.scope, old), true); assert.equal(await b.repo.claim(f.scope), undefined);
    await owner.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE contract=$1 AND id=$2", [f.scope.contract, old.id]);
    assert.equal(await a.repo.heartbeat(f.scope, old), false);
    const next = await b.repo.claim(f.scope); assert.equal(next.id, old.id); assert.equal(next.fence, '2');
    assert.equal(await a.repo.fail(f.scope, old), false); assert.equal(await f.active(), 1);
    assert.equal(await a.repo.claim(f.scope), undefined);
  });
  await t.test('lowering capacity drains existing leases; stale snapshots are refused', async () => {
    const f = await fixture(); const a = f.workers[0];
    const first = await a.repo.claim(f.scope), second = await a.repo.claim(f.scope);
    await owner.query('UPDATE shorts_runtime SET max_processing=1 WHERE contract=$1', [f.scope.contract]);
    assert.equal(await a.repo.heartbeat(f.scope, first), true);
    assert.equal(await a.repo.claim(f.scope), undefined);
    await a.repo.fail(f.scope, first); assert.equal(await a.repo.claim(f.scope), undefined);
    await a.repo.fail(f.scope, second); assert.ok(await a.repo.claim(f.scope));
    await assert.rejects(owner.transaction('REPEATABLE READ', async manager => {
      await manager.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()+interval '1 minute' WHERE contract=$1 AND status='processing'", [f.scope.contract]);
    }), { code: 'SH400' });
    for (const value of [0, 33]) await assert.rejects(owner.query('UPDATE shorts_runtime SET max_processing=$1', [value]), { code: '23514' });
  });
  await t.test('rollback/reapply preserves uploads and content while restoring the guard', async () => {
    const previous = await fixture(1, 1);
    await previous.workers[0].repo.verifyRuntime(previous.scope, hash);
    await owner.query('ALTER TABLE shorts_ingestion DISABLE TRIGGER shorts_processing_capacity');
    await assert.rejects(previous.workers[0].repo.verifyRuntime(previous.scope, hash), { status: 503 });
    await owner.query('ALTER TABLE shorts_ingestion ENABLE TRIGGER shorts_processing_capacity');
    await owner.query("UPDATE shorts_ingestion SET status='queued',error_code=NULL,lease_until=NULL,lease_token=NULL,lease_principal=NULL WHERE status='processing' OR error_code='capacity_wait'");
    const before = await owner.query('SELECT network,contract,id,status,attempts FROM shorts_ingestion ORDER BY contract,id');
    await owner.transaction(manager => new ShortsWorkerBackpressure().down(manager));
    await assert.rejects(previous.workers[0].repo.verifyRuntime(previous.scope, hash), { status: 503 });
    await owner.undoLastMigration({ transaction: 'all' });
    await assert.rejects(previous.workers[0].repo.verifyRuntime(previous.scope, hash), { status: 503 });
    assert.deepEqual(await owner.query('SELECT network,contract,id,status,attempts FROM shorts_ingestion ORDER BY contract,id'), before);
    await owner.runMigrations({ transaction: 'all' });
    await new ShortsWorkerBackpressure().up(owner);
    assert.deepEqual(await owner.query('SELECT network,contract,id,status,attempts FROM shorts_ingestion ORDER BY contract,id'), before);
    const f = await fixture(1, 2); await f.workers[0].repo.verifyRuntime(f.scope, hash);
    assert.ok(await f.workers[0].repo.claim(f.scope));
    assert.equal(await f.workers[1].repo.claim(f.scope), undefined);
  });
  await t.test('scanner backpressure survives worker replacement without discarding the source', { skip: !process.env.SHORTS_TEST_INGEST_ROOT }, async () => {
    const { join } = require('node:path');
    const root = require('./testing/standalone-ingest.cjs').ingestRoot();
    const { workerFixture } = require(join(root, 'src/shorts/testing/worker-backpressure.cjs'));
    const { ShortsModerationUnavailableError } = require(join(root, 'src/shorts/shorts-safety.service'));
    const f = await fixture(1, 1), [a, b] = f.workers;
    const before = await metadata.getJob(f.scope, 'ak_creator', 'job0');
    const runtime = workerFixture({ safety: { scan: async () => { throw new ShortsModerationUnavailableError(); } } });
    runtime.worker.config = { scope: f.scope, sourceHash: hash, leaseMs: 120000 };
    runtime.worker.metadata = a.repo;
    await runtime.worker.drain(); await runtime.worker.onModuleDestroy();
    const queued = await metadata.getJob(f.scope, 'ak_creator', 'job0');
    assert.equal(queued.status, 'queued'); assert.equal(queued.attempts, 0); assert.equal(queued.fence, '1');
    assert.deepEqual(queued.input, before.input); assert.equal(runtime.encoded.length, 0);
    assert.equal(await b.repo.claim(f.scope), undefined, 'a fresh worker cannot skip durable cooldown');
    await owner.query("UPDATE shorts_ingestion SET updated_at=clock_timestamp()-interval '6 seconds' WHERE contract=$1 AND id='job0'", [f.scope.contract]);
    const resumed = await b.repo.claim(f.scope);
    assert.equal(resumed.id, 'job0'); assert.equal(resumed.attempts, 1); assert.equal(resumed.fence, '2');
    assert.deepEqual(resumed.input, before.input); assert.equal(await a.repo.defer(f.scope, queued), false);
  });
  await t.test('capacity deferral is fenced, scoped and idempotent, with a durable not-before time', async () => {
    const f = await fixture(2, 2), [a, b] = f.workers;
    const old = await a.repo.claim(f.scope);
    await owner.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE contract=$1 AND id=$2", [f.scope.contract, old.id]);
    const current = await a.repo.claim(f.scope); assert.equal(current.attempts, 2);
    assert.equal(await a.repo.defer(f.scope, old), false);
    assert.equal(await b.repo.defer(f.scope, current), false);
    await assert.rejects(a.repo.defer({ ...f.scope, contract: 'ct_other' }, current), { status: 403 });
    await assert.rejects(a.db.query("SELECT shorts_media_worker('defer',$1::jsonb)", [JSON.stringify({ ...f.scope, sourceHash: hash,
      id: current.id, fence: current.fence, leaseToken: current.leaseToken, attempts: 0 })]), { code: 'SH400' });
    assert.equal(await a.repo.defer(f.scope, current), true);
    assert.equal(await a.repo.defer(f.scope, current), false, 'lost response replay cannot refund twice');
    assert.equal(await a.repo.fail(f.scope, current), false);
    assert.equal(await a.repo.heartbeat(f.scope, current), false);
    const [row] = await owner.query('SELECT * FROM shorts_ingestion WHERE contract=$1 AND id=$2', [f.scope.contract, current.id]);
    assert.equal(row.status, 'queued'); assert.equal(row.attempts, 1); assert.equal(String(row.fence), '2');
    assert.equal(row.lease_token, null); assert.equal(row.lease_principal, null); assert.equal(row.error_code, 'capacity_wait');
    assert.equal(row.lease_until, null); assert.ok(row.updated_at.getTime() + 5000 > Date.now() + 3500);
    const skipped = await metadata.claim(f.scope); assert.ok(skipped); assert.notEqual(skipped.id, current.id);
    assert.equal(await a.repo.claim(f.scope), undefined);
    const forced = await owner.query(`UPDATE shorts_ingestion SET status='processing',lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '1 minute',attempts=attempts+1,fence=fence+1 WHERE contract=$1 AND id=$2 RETURNING id`, [f.scope.contract, current.id]);
    assert.equal(forced[1], 0, 'older callers cannot ignore the not-before time');
    await assert.rejects(owner.transaction(manager => new ShortsWorkerBackpressure().down(manager)), /Drain processing/);
    await owner.query("UPDATE shorts_ingestion SET updated_at=clock_timestamp()-interval '6 seconds' WHERE contract=$1 AND id=$2", [f.scope.contract, current.id]);
    const resumed = await b.repo.claim(f.scope); assert.equal(resumed.id, current.id); assert.equal(resumed.attempts, 2); assert.equal(resumed.fence, '3');
    assert.equal(await a.repo.defer(f.scope, current), false);
    await owner.query("UPDATE shorts_ingestion SET lease_until=clock_timestamp()-interval '1 second' WHERE contract=$1 AND id=$2", [f.scope.contract, resumed.id]);
    assert.equal(await b.repo.defer(f.scope, resumed), false, 'expiry cannot refund an attempt');
  });
});

require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { DataSource } = require('typeorm');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsStreamingOutbox1791763206000 } = require('../migrations/1791763206000-ShortsStreamingOutbox');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsStreamJobsService } = require('./shorts-stream-jobs.service');
const { ShortsStreamingService } = require('./shorts-streaming.service');
const { ShortsRecordsService } = require('./shorts-records.service');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('shared playback outbox: atomic publication, independent dispatchers and crash recovery', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_stream_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema,
    extra: { options: `-c search_path=${schema}`, max: 8, statement_timeout: 10000 },
    migrations: [ShortsMetadata1791763200000, ShortsStreamingOutbox1791763206000] };
  const one = new DataSource(options), two = new DataSource(options);
  const directory = await mkdtemp(join(tmpdir(), 'shorts-shared-outbox-'));
  const key = join(directory, 'key'); await writeFile(key, 'a'.repeat(64), { mode: 0o600 });
  const originalEnv = { ...process.env }, originalFetch = global.fetch;
  let child, server;
  t.after(async () => {
    global.fetch = originalFetch; process.env = originalEnv;
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await two.destroy(); await one.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  await one.initialize(); await two.initialize(); await one.runMigrations({ transaction: 'all' });
  const meta = new ShortsMetadataService(one), otherMeta = new ShortsMetadataService(two);
  const a = new ShortsStreamJobsService(one), b = new ShortsStreamJobsService(two);
  async function scope() {
    const s = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` };
    await meta.initialize(s, 'a'.repeat(64)); return s;
  }
  async function video(s, id = randomUUID(), published = true) {
    await meta.insertDraft(s, { id, creator: 'ak_creator', cid: 'bafyfixture', bytes: 100,
      duration: 10, createdAt: Date.now(), title: 'Owned video', topic: 'Art',
      files: [{ name: 'video.mp4', bytes: 100, sha256: 'a'.repeat(64) }],
      moderation: 'pending', views: [], reports: 0 });
    if (published) await meta.change(s, id, v => { v.publication = 'published'; v.moderation = 'approved'; v.safety = { status: 'no_flags' }; });
    return id;
  }
  async function job(s, id) {
    return (await one.query('SELECT * FROM shorts_stream_jobs WHERE network=$1 AND contract=$2 AND id=$3', [s.network, s.contract, id]))[0];
  }
  async function due(s, id) {
    await one.query('UPDATE shorts_stream_jobs SET next_at=clock_timestamp() WHERE network=$1 AND contract=$2 AND id=$3', [s.network, s.contract, id]);
  }
  function runtime(s, db = one) {
    const metadata = db === one ? meta : otherMeta;
    const records = new ShortsRecordsService({ release: { network: 'ae_uat', contract: s.contract }, state: { contract: s.contract, sourceHash: 'a'.repeat(64) } }, metadata);
    // Hosted dispatch must never consult a process-local SQLite outbox or snapshot.
    const store = new Proxy({}, { get() { throw new Error('Unexpected local state access'); } });
    return new ShortsStreamingService(store, { demoAutoApprove: false }, records, db === one ? a : b);
  }
  Object.assign(process.env, { SHORTS_STREAM_INTERNAL_URL: 'http://127.0.0.1:3337', SHORTS_STREAM_KEY_FILE: key });

  await t.test('publication and its job commit or roll back together; unrelated edits do not reschedule', async () => {
    const s = await scope(), id = await video(s, undefined, false);
    assert.equal(await job(s, id), undefined);
    await assert.rejects(one.transaction(async db => {
      await db.query(`UPDATE shorts_content SET body=jsonb_set(body,'{publication}','"published"') WHERE network=$1 AND contract=$2 AND id=$3`, [s.network, s.contract, id]);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM shorts_stream_jobs WHERE contract=$1', [s.contract]))[0].n, 1);
      throw new Error('rollback publication');
    }), /rollback publication/);
    assert.equal(await job(s, id), undefined);
    await meta.change(s, id, v => { v.publication = 'published'; v.moderation = 'approved'; });
    const claim = await a.claim(s); assert.equal(await a.settle(s, claim, 'ready'), true);
    await otherMeta.change(s, id, v => { v.title = 'Edited title'; v.reports++; });
    await Promise.all([a.enqueue(s, id), b.enqueue(s, id)]);
    assert.equal((await job(s, id)).ready, true); assert.equal(await b.claim(s), undefined);
  });
  await t.test('independent dispatchers claim disjoint jobs and scopes; stale or foreign tokens cannot acknowledge', async () => {
    const s = await scope(), alien = await scope();
    const first = await video(s), second = await video(s); await video(alien, first);
    const [c, d] = await Promise.all([a.claim(s), b.claim(s)]);
    assert.deepEqual(new Set([c.id, d.id]), new Set([first, second]));
    assert.equal(await a.claim(s), undefined);
    assert.equal(await b.settle(alien, c, 'ready'), false);
    assert.equal(await b.settle(s, { ...c, token: randomUUID() }, 'ready'), false);
    assert.equal(await b.settle(s, d, 'pending'), true);
    assert.equal((await job(s, d.id)).ready, false); assert.equal(await a.claim(s), undefined);
    await due(s, d.id); const next = await b.claim(s);
    assert.equal(await a.settle(s, d, 'ready'), false);
    assert.equal(await b.settle(s, next, 'ready'), true);
    assert.equal(await a.settle(s, c, 'denied'), true);
  });
  await t.test('withdrawal, reapproval and CID changes invalidate in-flight acknowledgements', async () => {
    const s = await scope(), id = await video(s); const old = await a.claim(s);
    await otherMeta.change(s, id, v => { v.moderation = 'rejected'; });
    assert.equal(await a.settle(s, old, 'ready'), false);
    const rejected = await b.claim(s); assert.equal(await b.settle(s, rejected, 'denied'), true);
    await meta.change(s, id, v => { v.moderation = 'approved'; });
    const reapproved = await a.claim(s); assert.ok(reapproved);
    await assert.rejects(meta.change(s, id, v => { v.cid = 'bafynewfixture'; }), { status: 409 });
    // A privileged repair still invalidates delivery even though ordinary API changes forbid CID mutation.
    await one.query(`UPDATE shorts_content SET body=jsonb_set(body,'{cid}','"bafynewfixture"') WHERE contract=$1 AND id=$2`, [s.contract, id]);
    assert.equal(await a.settle(s, reapproved, 'denied'), false);
    const changed = await b.claim(s); assert.equal(changed.cid, 'bafynewfixture');
    await meta.change(s, id, v => { v.publication = 'withdrawn'; });
    await a.enqueue(s, id); assert.equal(await job(s, id), undefined);
    assert.equal(await b.settle(s, changed, 'ready'), false);
  });
  await t.test('expired acknowledgements are rejected after row-lock waits, then another instance retries', async () => {
    const s = await scope(), id = await video(s); const c = await a.claim(s, 1000);
    const runner = one.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    try {
      await runner.query('SELECT id FROM shorts_stream_jobs WHERE contract=$1 AND id=$2 FOR UPDATE', [s.contract, id]);
      const ack = b.settle(s, c, 'ready');
      await pause(1100); await runner.commitTransaction();
      assert.equal(await ack, false);
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
    const next = await b.claim(s); assert.ok(next); assert.notEqual(next.token, c.token);
    assert.equal(await a.settle(s, c, 'failed'), false);
    assert.equal(await b.settle(s, next, 'ready'), true);
  });
  await t.test('HTTP dispatch retries unavailable/preparing responses and rechecks policy after IO', async () => {
    const s = await scope(), id = await video(s), calls = [];
    let status = 503, after;
    global.fetch = async (url, init) => { calls.push({ url, init }); if (after) await after(); return new Response(null, { status }); };
    const first = runtime(s); await first.dispatch(); await first.onModuleDestroy();
    assert.equal((await job(s, id)).attempts, 1); assert.equal((await job(s, id)).ready, false);
    const next = runtime(s, two); status = 202; await due(s, id); await next.dispatch();
    assert.equal((await job(s, id)).ready, false); assert.equal((await job(s, id)).attempts, 0);
    status = 200; await due(s, id); after = () => meta.change(s, id, v => { v.moderation = 'rejected'; });
    await next.dispatch(); assert.equal(await job(s, id), undefined, 'new denied generation is dropped without another request');
    assert.equal(calls.length, 3);
    after = undefined; await meta.change(s, id, v => { v.moderation = 'approved'; }); await next.dispatch();
    assert.equal((await job(s, id)).ready, true);
    await next.dispatch(); assert.equal(calls.length, 4);
    assert.equal(calls[0].init.body, undefined); assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
    await next.onModuleDestroy(); global.fetch = originalFetch;
  });
  await t.test('a killed dispatcher is recovered after its lease without losing accepted work', async () => {
    const s = await scope(), id = await video(s);
    let firstRequest; const accepted = new Promise(resolve => { firstRequest = resolve; });
    let requests = 0;
    server = createServer((req, res) => { requests++; if (requests === 1) firstRequest(); else { res.writeHead(200); res.end(); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const script = `require('reflect-metadata');
      const {DataSource}=require('typeorm');
      const {ShortsMetadataService}=require('./src/shorts/shorts-metadata.service');
      const {ShortsRecordsService}=require('./src/shorts/shorts-records.service');
      const {ShortsStreamJobsService}=require('./src/shorts/shorts-stream-jobs.service');
      const {ShortsStreamingService}=require('./src/shorts/shorts-streaming.service');
      (async()=>{const db=new DataSource(JSON.parse(process.env.OUTBOX_TEST_DB));await db.initialize();
        const jobs=new ShortsStreamJobsService(db),claim=jobs.claim.bind(jobs);jobs.claim=s=>claim(s,1000);
        const records=new ShortsRecordsService({release:{network:'ae_uat',contract:process.env.OUTBOX_TEST_CONTRACT},state:{contract:process.env.OUTBOX_TEST_CONTRACT,sourceHash:'a'.repeat(64)}},new ShortsMetadataService(db));
        await new ShortsStreamingService({}, {demoAutoApprove:false}, records, jobs).dispatch();
        await db.destroy();})().catch(()=>process.exit(1));`;
    child = spawn(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', '-e', script], {
      cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], env: {
        PATH: process.env.PATH, TS_NODE_TRANSPILE_ONLY: 'true', DOTENV_CONFIG_PATH: '/dev/null',
        OUTBOX_TEST_DB: JSON.stringify({ ...options, migrations: [] }), OUTBOX_TEST_CONTRACT: s.contract,
        SHORTS_STREAM_INTERNAL_URL: endpoint, SHORTS_STREAM_KEY_FILE: key,
      },
    });
    let timer;
    try { await Promise.race([accepted, once(child, 'exit').then(() => { throw new Error('Dispatcher exited before sending'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Dispatch deadline')), 12000); })]); }
    finally { clearTimeout(timer); }
    assert.equal((await job(s, id)).ready, false); child.kill('SIGKILL'); await once(child, 'exit'); child = undefined;
    await pause(1100); process.env.SHORTS_STREAM_INTERNAL_URL = endpoint;
    const replacement = runtime(s, two); await replacement.dispatch(); await replacement.onModuleDestroy();
    assert.equal((await job(s, id)).ready, true); assert.equal(requests, 2, 'at-least-once dispatch repeats the idempotent prepare request');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined;
    process.env.SHORTS_STREAM_INTERNAL_URL = 'http://127.0.0.1:3337';
  });
  await t.test('shutdown aborts active IO; database failure cannot create a false ready result', async () => {
    const s = await scope(), id = await video(s); let started;
    const sent = new Promise(resolve => { started = resolve; });
    global.fetch = async (_, init) => { started(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); };
    const active = runtime(s); const pending = active.dispatch(); await sent;
    await active.onModuleDestroy(); await pending;
    assert.equal((await job(s, id)).ready, false); assert.ok((await job(s, id)).lease_token);
    const unavailable = runtime(s);
    unavailable.jobs = { claim: async () => { throw new Error('database unavailable'); } };
    await unavailable.dispatch(); await unavailable.onModuleDestroy();
    assert.equal((await job(s, id)).ready, false); global.fetch = originalFetch;
  });
  await t.test('migration backfills published records and bootstrap verifies the deployment without a local scan', async () => {
    const s = await scope(), id = await video(s), pending = await video(s, undefined, false);
    const before = (await meta.get(s, id)).record;
    await one.undoLastMigration({ transaction: 'all' });
    const without = runtime(s); await assert.rejects(without.initialize());
    await one.runMigrations({ transaction: 'all' });
    assert.equal((await job(s, id)).ready, false); assert.equal(await job(s, pending), undefined);
    assert.deepEqual((await meta.get(s, id)).record, before);
    await assert.rejects(a.verify(s, 'b'.repeat(64)), { status: 503 });
    delete process.env.SHORTS_STREAM_INTERNAL_URL;
    const boot = runtime(s); await boot.initialize(); boot.start(); await boot.onModuleDestroy();
    assert.ok(await job(s, id), 'disabled delivery retains work until an endpoint is configured');
  });
});


test('dispatch deadline covers both metadata reads and HTTP; no late ready acknowledgement', { timeout: 5000 }, async t => {
  const env = { ...process.env };
  const dir = await mkdtemp(join(tmpdir(), 'shorts-dispatch-deadline-')), key = join(dir, 'key');
  await writeFile(key, 'a'.repeat(64), { mode: 0o600 });
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++; res.writeHead(200); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { process.env = env; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  Object.assign(process.env, { SHORTS_STREAM_INTERNAL_URL: `http://127.0.0.1:${server.address().port}`, SHORTS_STREAM_KEY_FILE: key });
  for (const mode of ['before-request', 'after-response']) {
    let claimed = false, settled = 0, reads = 0;
    const record = { id: 'fixture', cid: 'bafyfixture', publication: 'published', moderation: 'approved', safety: { status: 'no_flags' } };
    const jobs = {
      async claim() { if (claimed) return; claimed = true; return { id: record.id, cid: record.cid }; },
      async settle() { settled++; },
    };
    const records = { chain: { release: { network: 'ae_uat', contract: 'ct_fixture'  }, state: { contract: 'ct_fixture' } }, async find() {
      reads++;
      // Stall the selected metadata phase beyond the whole-job deadline. Keep
      // the other phases fast so scheduler jitter cannot choose a different phase.
      if (mode === 'before-request' || reads === 2) await pause(650);
      return record;
    } };
    const service = new ShortsStreamingService({}, { demoAutoApprove: false }, records, jobs, 500);
    const before = requests; await service.dispatch(); await service.onModuleDestroy();
    assert.equal(settled, 0); assert.equal(requests - before, mode === 'before-request' ? 0 : 1);
    assert.equal(reads, mode === 'before-request' ? 1 : 2);
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { ShortsUploadsService } = require('./shorts-uploads.service');
const { ShortsUploadLimitsService } = require('./shorts-upload-limits.service');
const { ShortsWorkQueueService } = require('./shorts-work-queue.service');
const { ShortsChainService } = require('./shorts-chain.service');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }

test('prepared draft commits remain durable while network mutations wait, with idempotency and rollback', async () => {
  const work = new ShortsWorkQueueService(), network = deferred(), started = deferred();
  let saved, fail = false;
  const chain = new ShortsChainService({ save: state => {
    if (fail) throw new Error('Storage full');
    saved = structuredClone(state);
  } }, work);
  const mutation = chain.serial(async () => { started.resolve(); await network.promise; });
  await started.promise;
  const first = { id: 'first', creator: 'creator' };
  assert.equal(chain.registerPrepared(first), first);
  assert.deepEqual(saved.shorts, [first]);
  assert.equal(chain.registerPrepared({ ...first, title: 'duplicate' }), first);
  assert.throws(() => chain.registerPrepared({ ...first, creator: 'other' }), /identity mismatch/);
  fail = true;
  assert.throws(() => chain.registerPrepared({ id: 'second', creator: 'creator' }), /Storage full/);
  assert.deepEqual(chain.state.shorts, [first]);
  assert.deepEqual(saved.shorts, [first]);
  network.resolve(); await mutation;
});
function setup(t, capacity = 8) {
  const db = new DatabaseSync(':memory:'), parts = new Map();
  t.after(() => db.close());
  const work = new ShortsWorkQueueService();
  const shorts = { chain: { state: { shorts: [] }, serial: fn => work.run(fn) }, media: {
    saveUploadPart: async (id, index, bytes) => parts.set(`${id}:${index}`, bytes),
    loadUploadPart: async (id, index) => parts.get(`${id}:${index}`),
    removeUploadParts: async (id, count) => { for (let i = 0; i < count; i++) parts.delete(`${id}:${i}`); },
    removeOrphanedPrepared: async () => {},
  }, item: id => shorts.chain.state.shorts.find(s => s.id === id),
    upload: async (creator, title, topic, bytes, details, id) => {
      const video = { creator, title, topic, bytes: bytes.length, id, moderation: 'pending' };
      shorts.chain.state.shorts.push(video); return video;
    } };
  const previous = process.env.SHORTS_INGEST_QUEUE_CAPACITY;
  process.env.SHORTS_INGEST_QUEUE_CAPACITY = String(capacity);
  const uploads = new ShortsUploadsService({ db }, shorts, new ShortsUploadLimitsService({ db }));
  if (previous === undefined) delete process.env.SHORTS_INGEST_QUEUE_CAPACITY; else process.env.SHORTS_INGEST_QUEUE_CAPACITY = previous;
  const bytes = Buffer.from('fixture');
  async function input(actor = 'creator') {
    const session = await uploads.create(actor, { title: 'Owned clip', topic: 'Art', rights: true,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), details: {} });
    await uploads.part(actor, session.id, 0, bytes); return session;
  }
  return { db, work, shorts, uploads, input, bytes };
}

test('durable queue admission is idempotent, bounded, owned and freezes accepted parts', async t => {
  const f = setup(t, 2), first = await f.input(), second = await f.input('other'), third = await f.input('third');
  const queued = await f.uploads.finish('creator', first.id);
  assert.equal(queued.status, 'queued'); assert.equal(queued.video, undefined);
  await assert.rejects(f.uploads.finish('other', first.id), { status: 404 });
  assert.deepEqual(await f.uploads.finish('creator', first.id), queued);
  await assert.rejects(f.uploads.part('creator', first.id, 0, f.bytes), { status: 409 });
  await f.uploads.finish('other', second.id);
  await assert.rejects(f.uploads.finish('third', third.id), { status: 503 });
  const health = f.uploads.health();
  assert.equal(health.queued, 2); assert.ok(health.oldestQueuedMs >= 0);
  assert.equal(JSON.stringify(health).includes('creator'), false);
  await f.uploads.drain();
  assert.equal(f.shorts.chain.state.shorts.length, 2);
  assert.equal((await f.uploads.get('creator', first.id)).status, 'ready');
  await f.uploads.finish('third', third.id); await f.uploads.drain();
  assert.equal(f.shorts.chain.state.shorts.length, 3);
});

test('one creator cannot occupy the entire queue; slow preparation does not hold the mutation queue', async t => {
  const f = setup(t), gate = deferred(), started = deferred();
  const first = await f.input(), second = await f.input(), third = await f.input();
  await f.uploads.finish('creator', first.id); await f.uploads.finish('creator', second.id);
  await assert.rejects(f.uploads.finish('creator', third.id), { status: 503 });
  const original = f.shorts.upload;
  f.shorts.upload = async (...args) => { started.resolve(); await gate.promise; return original(...args); };
  const running = f.uploads.drain(); await started.promise;
  assert.equal(await f.work.run(async () => 'unrelated mutation completed'), 'unrelated mutation completed');
  let closed = false;
  const closing = f.uploads.onModuleDestroy().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  gate.resolve(); await Promise.all([running, closing]);
  assert.equal(f.uploads.health().queued, 1, 'shutdown leaves unstarted jobs durable');
  assert.equal(f.shorts.chain.state.shorts.length, 1);
});

test('concurrent finish requests cannot bypass admission after an asynchronous content read', async t => {
  const f = setup(t, 2);
  const sessions = await Promise.all(Array.from({ length: 6 }, (_, i) => f.input(`creator${i}`)));
  const results = await Promise.allSettled(sessions.map((s, i) => f.uploads.finish(`creator${i}`, s.id)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 503));
  assert.equal(f.uploads.health().queued, 2);
  const repeated = await Promise.all(Array.from({ length: 8 }, () => f.uploads.finish('creator0', sessions[0].id)));
  assert.ok(repeated.every(r => r.status === 'queued' && r.id === sessions[0].id));
  assert.equal(f.uploads.health().queued, 2);
});

test('accepted jobs survive the partial-upload expiry window and failed jobs expose no internal paths', async t => {
  const f = setup(t), session = await f.input();
  await f.uploads.finish('creator', session.id);
  const row = JSON.parse(f.db.prepare('SELECT body FROM shorts_uploads WHERE id=?').get(session.id).body);
  row.created = Date.now() - 25 * 3600000;
  f.db.prepare('UPDATE shorts_uploads SET created=?,body=? WHERE id=?').run(row.created, JSON.stringify(row), row.id);
  assert.equal((await f.uploads.get('creator', row.id)).status, 'queued');
  f.shorts.upload = async () => { throw new Error('secret path /private/input/ and provider token'); };
  await f.uploads.onApplicationBootstrap(); await f.uploads.drain(); await f.uploads.onModuleDestroy();
  assert.equal(f.db.prepare('SELECT status FROM shorts_ingest_jobs').get().status, 'failed');
  assert.equal(String(f.db.prepare('SELECT error FROM shorts_ingest_jobs').get().error).includes('/private'), false);
  assert.equal((await f.uploads.get('creator', row.id)).status, 'failed');
  f.db.prepare('UPDATE shorts_ingest_jobs SET updated=?').run(Date.now() - 25 * 3600000);
  await assert.rejects(f.uploads.get('creator', row.id), { status: 410 });
  await f.uploads.cleanup();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shorts_ingest_jobs').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shorts_uploads').get().n, 0);
});

test('reconciliation does not revisit existing records when preparation registers another draft during network IO', async () => {
  const { ShortsHostingService } = require('./shorts-hosting.service');
  const first = { id: 'existing', cid: 'original', moderation: 'approved', publication: 'published' };
  const state = { shorts: [first] }, reads = [];
  const worker = new ShortsHostingService({ state, serial: fn => fn(), read: async (method, [id]) => {
    reads.push(id);
    if (reads.length === 1) state.shorts.unshift({ id: 'new', moderation: 'pending' });
    return { withdrawn: false };
  } }, { pins: async () => new Set(['original']), hasPin: () => true,
    unpin: async () => assert.fail('Active media cannot be unpinned'),
  }, { demoAutoApprove: true });
  await worker.reconcile();
  assert.deepEqual(reads, ['existing', 'existing']);
});

for (const stage of ['queued', 'processing', 'registered']) {
  test(`SIGKILL recovery after ${stage} resumes the same job without duplicate registered videos`, { timeout: 20000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'shorts-ingest-crash-')), children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await child.exited;
      }
      await rm(directory, { recursive: true, force: true });
    });
    function start(mode) {
      const env = { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', NODE_ENV: 'test', SHORTS_DATA_DIR: directory,
        SHORTS_IPFS_API: 'http://127.0.0.1:35002/api/v0', INGEST_TEST_MODE: mode };
      for (const key of ['SHORTS_IPFS_TOKEN_FILE', 'SHORTS_IPFS_APIS', 'SHORTS_IPFS_CREDENTIALS_FILE']) delete env[key];
      const child = spawn(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', 'src/shorts/testing/ingest-worker.cjs'],
        { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child); child.exited = once(child, 'exit');
      const messages = []; child.on('message', message => messages.push(message));
      let diagnostics = ''; child.stderr.on('data', bytes => { diagnostics += bytes; });
      async function waitFor(expected) {
        for (let i = 0; i < 1000; i++) {
          const message = messages.find(item => item.stage === expected || item.error);
          if (message?.error) throw new Error(message.error);
          if (message) return message;
          if (child.exitCode !== null) throw new Error(`Worker exited: ${diagnostics}`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`Worker did not reach ${expected}: ${diagnostics}`);
      }
      return { child, waitFor };
    }
    const first = start(stage);
    const queued = await first.waitFor('queued'); assert.equal(queued.status.status, 'queued');
    await first.waitFor(stage); first.child.kill('SIGKILL'); await first.child.exited;
    const recovery = start('recover'), result = await recovery.waitFor('recovered');
    assert.equal(result.status.id, queued.status.id);
    assert.equal(result.status.status, 'ready'); assert.equal(result.status.complete, true);
    assert.equal(result.records, 1); assert.equal(result.receipts, 0, 'preparation never publishes or sends a transaction');
    assert.equal(result.preparations, stage === 'processing' ? 2 : 1);
    recovery.child.send('close'); await recovery.child.exited;
  });
}

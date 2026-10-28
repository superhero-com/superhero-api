const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { NestFactory } = require('@nestjs/core');
const { UnauthorizedException, ForbiddenException } = require('@nestjs/common');
const { catalogCursor, catalogMap } = require('./shorts-catalog');
const { ShortsService } = require('./shorts.service');
const { ShortsRecordsService } = require('./shorts-records.service');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsController } = require('./shorts.controller');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsAuthGuard } = require('./shorts-auth.guard');
const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
const { ShortsUploadsService } = require('./shorts-uploads.service');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsCatalog1791763211000 } = require('../migrations/1791763211000-ShortsCatalog');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(r => setImmediate(r));
const clip = (index, creator = 'ak_creator') => ({
  id: `clip-${String(index).padStart(4, '0')}`, creator, title: `Short ${index}`, topic: 'Art',
  createdAt: 1000 + Math.floor(index / 3), cid: `bafy${index}`, bytes: 123, duration: 10,
  moderation: 'approved', publication: 'published', safety: { status: 'no_flags' },
  views: [], reports: 0, files: [{ name: 'video.mp4', bytes: 123, sha256: 'a'.repeat(64) }],
  privateMedia: { internal: 'never expose this' },
});
function service(shorts) {
  const calls = [];
  const chain = {
    release: { network: 'ae_uat', contract: 'ct_catalog' },
    state: { contract: 'ct_catalog', sourceHash: 'a'.repeat(64), shorts },
    address: a => a,
    read: async (method, args) => {
      calls.push({ method, args });
      if (method === 'has_liked') return false;
      const s = shorts.find(row => row.id === args[0]);
      return s && { cid: s.cid, creator: s.creator, size: BigInt(s.bytes), likes: 1n };
    },
  };
  const records = new ShortsRecordsService(chain);
  const api = new ShortsService(chain, {}, { counters: async () => ({ views: 1 }) }, {}, {}, {}, {}, {}, records);
  return { api, chain, calls, records };
}

test('catalog cursors reject malformed input and bind deployment, endpoint and account', () => {
  const scope = ['ae_uat', 'ct_example', 'hash', 'studio', 'ak_creator'];
  const codec = catalogCursor(scope), position = { at: 123, id: 'clip-001' };
  const cursor = codec.encode(position);
  assert.deepEqual(catalogCursor(scope, cursor).after, position);
  for (let i = 0; i < scope.length; i++) {
    const other = [...scope]; other[i] = 'changed';
    assert.throws(() => catalogCursor(other, cursor), { status: 400 });
  }
  for (const value of ['', [], {}, 'a'.repeat(513), `${cursor}=`, '___', Buffer.from('null').toString('base64url')])
    assert.throws(() => catalogCursor(scope, value), { status: 400 });
  for (const position of [{ at: -1, id: 'ok' }, { at: 1.5, id: 'ok' }, { at: 1, id: '../private' }])
    assert.throws(() => catalogCursor(scope, codec.encode(position)), { status: 400 });
});

test('catalog limits chain concurrency and drains in-flight reads before releasing failures', async () => {
  const gate = deferred(); let active = 0, peak = 0, calls = 0, ended = false;
  const task = catalogMap(Array.from({ length: 20 }, (_, i) => i), async i => {
    calls++; active++; peak = Math.max(peak, active);
    try { await turn(); if (i === 0) throw new Error('unavailable'); await gate.promise; return i; }
    finally { active--; }
  }).catch(error => { ended = true; return error; });
  await turn(); assert.equal(ended, false); assert.equal(calls, 4); assert.equal(peak, 4);
  gate.resolve(); assert.equal((await task).message, 'unavailable'); assert.equal(active, 0);
});

test('local catalog returns stable pages without duplicates when newer clips arrive', async () => {
  const f = service(Array.from({ length: 47 }, (_, i) => clip(i)));
  const first = await f.api.catalog(); assert.equal(first.items.length, 20); assert.ok(first.next);
  f.chain.state.shorts.push({ ...clip(100), createdAt: 9000 });
  const second = await f.api.catalog('', first.next);
  const third = await f.api.catalog('', second.next);
  assert.equal(second.items.length, 20); assert.equal(third.items.length, 7); assert.equal(third.next, null);
  const ids = [...first.items, ...second.items, ...third.items].map(s => s.id);
  assert.equal(new Set(ids).size, 47); assert.ok(!ids.includes('clip-0100'));
  assert.ok(first.items.every(s => !('privateMedia' in s) && !('files' in s)));
  const retry = await f.api.catalog('', first.next);
  assert.deepEqual(retry, second);
});

test('empty public pages retain continuation and never probe unsafe candidates', async () => {
  const f = service(Array.from({ length: 26 }, (_, i) => ({ ...clip(i), safety: { status: i >= 6 ? 'error' : 'no_flags' } })));
  const first = await f.api.catalog(); assert.deepEqual(first.items, []); assert.ok(first.next);
  assert.equal(f.calls.length, 0);
  const second = await f.api.catalog('', first.next); assert.equal(second.items.length, 6); assert.equal(second.next, null);
  assert.equal(f.calls.length, 6);
});

test('public cursors never reveal the position of private local drafts', async () => {
  const f = service(Array.from({ length: 30 }, (_, i) => ({ ...clip(i), publication: undefined, moderation: 'pending' })));
  assert.deepEqual(await f.api.catalog(), { items: [], next: null });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.api.catalog('ak_creator', undefined, true)).items.length, 20);
});

test('current policy, publication state and canonical media identity are rechecked after chain reads', async () => {
  for (const mutation of [
    s => { s.moderation = 'rejected'; },
    s => { s.publication = 'withdrawn'; },
    s => { s.safety = { status: 'error' }; },
  ]) {
    const f = service([clip(1)]), read = f.chain.read;
    f.chain.read = async (...args) => { const v = await read(...args); mutation(f.chain.state.shorts[0]); return v; };
    assert.deepEqual((await f.api.catalog()).items, []);
  }
  const f = service([clip(1)]);
  f.chain.read = async () => ({ cid: 'other', creator: 'ak_creator', size: 123n, likes: 1n });
  assert.deepEqual((await f.api.catalog()).items, []);
});

test('catalog rejects excess requests, shares admission with legacy reads and recovers capacity', async () => {
  const f = service([clip(1)]), gate = deferred(); let reads = 0;
  f.chain.read = async () => { reads++; await gate.promise; return undefined; };
  const tasks = Array.from({ length: 4 }, () => f.api.catalog());
  await turn(); assert.equal(reads, 4);
  await assert.rejects(f.api.catalog(), { status: 503 });
  await assert.rejects(f.api.list(), { status: 503 });
  await assert.rejects(f.api.reviewPage('ak_operator'), { status: 503 });
  gate.resolve(); await Promise.all(tasks);
  await f.api.catalog(); assert.equal(reads, 5);
});

test('concurrent catalog pages share one item-read limit and preserve every page', async () => {
  const f = service(Array.from({ length: 20 }, (_, i) => clip(i)));
  const gate = deferred(), read = f.chain.read;
  let active = 0, peak = 0;
  f.chain.read = async (...args) => {
    active++; peak = Math.max(peak, active);
    try { await gate.promise; await turn(); return await read(...args); }
    finally { active--; }
  };
  const pages = Array.from({ length: 4 }, () => f.api.catalog());
  await turn();
  const initialPeak = peak;
  await assert.rejects(f.api.catalog(), { status: 503 });
  gate.resolve();
  const results = await Promise.all(pages);
  assert.equal(initialPeak, 4);
  assert.equal(peak, 4);
  assert.equal(active, 0);
  for (const page of results) {
    assert.equal(page.items.length, 20);
    assert.equal(new Set(page.items.map(s => s.id)).size, 20);
    assert.deepEqual(page, results[0]);
  }
  assert.equal((await f.api.catalog()).items.length, 20);
});

test('a failed catalog page drains its readers and returns shared permits to waiting pages', async () => {
  const f = service(Array.from({ length: 20 }, (_, i) => clip(i)));
  const gate = deferred(), read = f.chain.read;
  let calls = 0, active = 0, peak = 0, failedPageEnded = false;
  f.chain.read = async (...args) => {
    const first = ++calls === 1;
    active++; peak = Math.max(peak, active);
    try {
      await turn();
      if (first) throw new Error('read unavailable');
      await gate.promise;
      return await read(...args);
    } finally { active--; }
  };
  const failed = f.api.catalog().catch(error => { failedPageEnded = true; return error; });
  const waiting = Array.from({ length: 3 }, () => f.api.catalog());
  await turn(); await turn();
  assert.equal(failedPageEnded, false);
  assert.equal(peak, 4);
  gate.resolve();
  assert.equal((await failed).message, 'read unavailable');
  for (const page of await Promise.all(waiting)) assert.equal(page.items.length, 20);
  assert.equal(active, 0);
  assert.equal(peak, 4);
  assert.equal((await f.api.catalog()).items.length, 20);
});

test('catalog HTTP endpoints authenticate Studio, isolate account cursors and prevent shared caching', async t => {
  const f = service(Array.from({ length: 25 }, (_, i) => ({ ...clip(i), moderation: 'pending' })));
  f.chain.state.shorts.push({ ...clip(90, 'ak_other'), moderation: 'pending' });
  const auth = { authenticate: async value => {
    if (value === 'Bearer creator') return 'ak_creator';
    if (value === 'Bearer other') return 'ak_other';
    throw new UnauthorizedException();
  } };
  const app = await NestFactory.create({ module: class CatalogTestModule {}, controllers: [ShortsController],
    providers: [ShortsAuthGuard, ShortsUploadInterceptor,
      { provide: ShortsAuthService, useValue: auth }, { provide: ShortsService, useValue: f.api },
      { provide: ShortsUploadsService, useValue: {} }],
  }, { logger: false });
  t.after(() => app.close()); await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/shorts`;
  assert.equal((await fetch(`${base}/content?address=ak_creator`)).status, 401);
  const first = await fetch(`${base}/content?address=ak_other&limit=1000000`, { headers: { authorization: 'Bearer creator' } });
  assert.equal(first.headers.get('cache-control'), 'no-store'); const page = await first.json();
  assert.equal(page.items.length, 20); assert.ok(page.items.every(row => row.creator === 'ak_creator'));
  assert.equal((await fetch(`${base}/content?cursor=${page.next}`, { headers: { authorization: 'Bearer other' } })).status, 400);
  assert.equal((await fetch(`${base}/feed?address=ak_creator&cursor=${page.next}`)).status, 400);
  const publicResponse = await fetch(`${base}/feed`);
  assert.equal(publicResponse.headers.get('cache-control'), 'no-store'); assert.deepEqual((await publicResponse.json()).items, []);
  assert.equal((await fetch(`${base}/feed?cursor=one&cursor=two`)).status, 400);
  const refreshed = await fetch(`${base}/feed/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['clip-0001'] }) });
  assert.equal(refreshed.status, 200); assert.equal(refreshed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await refreshed.json(), { items: [] });
});

test('window refresh validates bounded IDs, excludes private content and never reads the full registry', async () => {
  const f = service([clip(1), { ...clip(2), publication: undefined }, { ...clip(3), moderation: 'rejected' }]);
  f.records.all = async () => assert.fail('No full catalog reads');
  const result = await f.api.catalogState('ak_creator', ['clip-0001', 'clip-0002', 'clip-0003', 'missing']);
  assert.deepEqual(result.items.map(s => s.id), ['clip-0001']);
  assert.equal(f.calls.filter(c => c.method === 'get_short').length, 1);
  assert.equal(result.items[0].mine, true); assert.equal(result.items[0].liked, false);
  assert.deepEqual(await f.api.catalogState('', []), { items: [] });
  for (const ids of [undefined, {}, 'all', ['clip-0001', 'clip-0001'], ['../private'], Array.from({ length: 21 }, (_, i) => `clip-${i}`)])
    await assert.rejects(f.api.catalogState('', ids), { status: 400 });
  await assert.rejects(f.api.catalogState({}, []), { status: 400 });
  f.chain.state.shorts[0].safety = { status: 'blocked' };
  assert.deepEqual(await f.api.catalogState('', ['clip-0001']), { items: [] });
});


test('hosted legacy reads and local preparation refuse before database, node or media work', async () => {
  const f = service([]);
  f.records = new ShortsRecordsService(f.chain, { page: async () => assert.fail('No legacy database scans') });
  f.api.records = f.records;
  f.chain.account = async () => assert.fail('No legacy account work');
  await assert.rejects(f.records.all(), { status: 503 });
  await assert.rejects(f.api.list(), { status: 410 });
  await assert.rejects(f.api.dashboard('ak_creator'), { status: 410 });
  await assert.rejects(f.api.upload('ak_creator', 'Title', 'Art', Buffer.alloc(1)), { status: 503 });
  assert.throws(() => new ShortsUploadsService({}, f.api, {}), { status: 503 }, 'shared records cannot start the local worker');
  assert.equal(f.calls.length, 0);
});

test('operator review HTTP paging reauthorizes every page and never exposes object references', async t => {
  const f = service(Array.from({ length: 47 }, (_, i) => ({ ...clip(i),
    publication: i % 3 === 0 ? undefined : i % 3 === 1 ? 'published' : 'withdrawn',
    moderation: i % 3 === 0 ? 'pending' : i % 3 === 1 ? 'approved' : 'rejected',
  })));
  f.records.all = async () => assert.fail('No whole-library read');
  let enabled = true, reads = 0;
  const reviewPage = f.records.reviewPage.bind(f.records);
  f.records.reviewPage = async (...args) => { reads++; return reviewPage(...args); };
  const auth = {
    authenticate: async value => {
      if (value === 'Bearer operator') return 'ak_operator';
      if (value === 'Bearer creator') return 'ak_creator';
      throw new UnauthorizedException();
    },
    operator: async value => {
      const actor = await auth.authenticate(value);
      if (!enabled || actor !== 'ak_operator') throw new ForbiddenException();
      return actor;
    },
  };
  const app = await NestFactory.create({ module: class ReviewCatalogTestModule {}, controllers: [ShortsController],
    providers: [ShortsAuthGuard, ShortsUploadInterceptor,
      { provide: ShortsAuthService, useValue: auth }, { provide: ShortsService, useValue: f.api },
      { provide: ShortsUploadsService, useValue: {} }],
  }, { logger: false });
  t.after(() => app.close()); await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/shorts`, headers = { authorization: 'Bearer operator' };
  assert.equal((await fetch(`${base}/review?address=ak_operator`)).status, 401);
  assert.equal((await fetch(`${base}/review`, { headers: { authorization: 'Bearer creator' } })).status, 403);
  assert.equal(reads, 0);
  const response = await fetch(`${base}/review?limit=1000000`, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const first = await response.json(); assert.equal(first.items.length, 20); assert.ok(first.next);
  assert.deepEqual(new Set(first.items.map(s => s.moderation)), new Set(['pending', 'approved', 'rejected']));
  assert.ok(first.items.every(s => !('privateMedia' in s) && !('files' in s) && !('cid' in s)));
  assert.equal((await fetch(`${base}/feed?cursor=${first.next}`)).status, 400);
  const creator = await f.api.catalog('ak_creator', undefined, true);
  const creatorReads = f.calls.length;
  assert.equal((await fetch(`${base}/review?cursor=${creator.next}`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/review?cursor=one&cursor=two`, { headers })).status, 400);
  enabled = false;
  assert.equal((await fetch(`${base}/review?cursor=${first.next}`, { headers })).status, 403);
  assert.equal(reads, 1, 'revoked access cannot use a previously issued cursor');
  enabled = true;
  f.chain.state.shorts.push({ ...clip(100), createdAt: 9000 });
  const second = await (await fetch(`${base}/review?cursor=${first.next}`, { headers })).json();
  const third = await (await fetch(`${base}/review?cursor=${second.next}`, { headers })).json();
  assert.equal(second.items.length, 20); assert.equal(third.items.length, 7); assert.equal(third.next, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(s => s.id)).size, 47);
  assert.equal(f.calls.length, creatorReads, 'operator pages do not make per-video chain reads');
});

test('PostgreSQL catalog pages read beyond the legacy cap with independent connections', { skip: !process.env.SHORTS_TEST_PG_URL }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_catalog_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}` },
    synchronize: false, migrations: [ShortsMetadata1791763200000, ShortsUploads1791763202000, ShortsCatalog1791763211000, ShortsUploadBudget1791763224000] };
  const db = new DataSource(options), other = new DataSource(options);
  await db.initialize(); await other.initialize();
  t.after(async () => { await other.destroy(); await db.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await db.runMigrations(); const metadata = new ShortsMetadataService(db), writer = new ShortsMetadataService(other);
  const scope = { network: 'ae_uat', contract: 'ct_catalog' };
  await metadata.initialize(scope, 'a'.repeat(64));
  await metadata.configureUploadBudget(scope, { uploads: 200, sourceBytes: 100000 });
  const f = service([]); f.records = new ShortsRecordsService(f.chain, metadata); f.api.records = f.records;
  for (let i = 0; i < 107; i++) {
    const record = { ...clip(i, i % 2 ? 'ak_other' : 'ak_creator'), moderation: 'pending', publication: undefined };
    // Explicitly configured fixture budget; the default deployment budget is unchanged.
    await writer.insertDraft(scope, record, 200);
    if (i < 83) await writer.change(scope, record.id, s => { s.moderation = 'approved'; s.publication = 'published'; });
    f.chain.state.shorts.push(record);
  }
  await assert.rejects(f.records.all(), { status: 503 });
  const secondApi = service([]).api;
  secondApi.chain = f.chain;
  secondApi.records = new ShortsRecordsService(f.chain, writer);
  let reviewCursor, reviewed = [], reviewPages = 0;
  do {
    const page = await (reviewPages % 2 ? f.api : secondApi).reviewPage('ak_operator', reviewCursor);
    reviewPages++;
    assert.ok(page.items.length <= 20);
    reviewed.push(...page.items.map(s => s.id)); reviewCursor = page.next ?? undefined;
    if (reviewPages === 1) { await other.destroy(); await other.initialize(); }
  } while (reviewCursor);
  assert.equal(reviewPages, 6); assert.equal(reviewed.length, 107); assert.equal(new Set(reviewed).size, 107);
  assert.ok(reviewed.includes('clip-0106'), 'operator pages include private pending drafts');
  assert.ok(reviewed.includes('clip-0001'), 'operator pages include published videos');
  await assert.rejects(f.api.list(), { status: 410 });
  let cursor, ids = [], pages = 0;
  do {
    const page = await f.api.catalog('', cursor); pages++;
    assert.ok(page.items.length <= 20); ids.push(...page.items.map(s => s.id)); cursor = page.next ?? undefined;
    if (pages === 1) {
      await writer.change(scope, 'clip-0060', s => { s.moderation = 'rejected'; });
      await writer.change(scope, 'clip-0050', s => { s.publication = 'withdrawn'; });
    }
  } while (cursor);
  assert.equal(pages, 5); assert.equal(ids.length, 81); assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('clip-0060') && !ids.includes('clip-0050') && !ids.includes('clip-0106'));
  const owned = await f.api.catalog('ak_creator', undefined, true);
  assert.equal(owned.items.length, 20); assert.ok(owned.items.every(s => s.creator === 'ak_creator'));
  const refreshed = await f.api.catalogState('', ['clip-0001', 'clip-0106', 'missing']);
  assert.deepEqual(refreshed.items.map(s => s.id), ['clip-0001']);
  const indices = await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='shorts_content_public_page'", [schema]);
  assert.match(indices[0].indexdef, /WHERE/);
  await db.transaction(manager => new ShortsCatalog1791763211000().down(manager)); assert.equal((await f.api.catalog()).items.length, 20);
});

require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { NestFactory } = require('@nestjs/core');
const { BadRequestException } = require('@nestjs/common');
const { ShortsFollowingService } = require('./shorts-following.service');
const { ShortsService } = require('./shorts.service');
const { ShortsRecordsService } = require('./shorts-records.service');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsController } = require('./shorts.controller');
const { ShortsAuthGuard } = require('./shorts-auth.guard');
const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsUploadsService } = require('./shorts-uploads.service');
const { SocialGraphProjectionService } = require('../plugins/social-graph/social-graph-projection.service');
const { SocialGraphProjection1718900000035 } = require('../migrations/1718900000035-SocialGraphProjection');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsCatalog1791763211000 } = require('../migrations/1791763211000-ShortsCatalog');
const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
const { ShortsFollowing1791763227000 } = require('../migrations/1791763227000-ShortsFollowing');

const scope = { network: 'ae_uat', contract: 'ct_catalog' }, hash = 'a'.repeat(64);
const graph = { network: 'ae_uat', contract: 'ct_social', generation: '9' };
const viewer = 'ak_viewer';

test('Following refuses missing/mismatched configuration before DB work and uses bounded node verification', async () => {
  const saved = [process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS, process.env.SOCIAL_GRAPH_NETWORK_ID];
  try {
    delete process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS;
    const db = { transaction: () => assert.fail('No query without verified identity') };
    const service = new ShortsFollowingService(db, {});
    await assert.rejects(service.page(scope, hash, viewer), { status: 503 });
    let called = 0;
    service.reader = { identity: graph, verifyIdentity: () => assert.fail('Cancelled node access must not run verification') };
    service.chain = { readNode: async () => { called++; throw new Error('node deadline'); } };
    await assert.rejects(service.page(scope, hash, viewer), /node deadline/);
    assert.equal(called, 1);
    await assert.rejects(service.current('ae_mainnet'), { status: 503 });
  } finally {
    ['SOCIAL_GRAPH_CONTRACT_ADDRESS', 'SOCIAL_GRAPH_NETWORK_ID'].forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
    });
  }
});

test('PostgreSQL Following selects the global catalog through existing graph projection', { skip: !process.env.SHORTS_TEST_PG_URL }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_following_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}` }, synchronize: false,
    migrations: [SocialGraphProjection1718900000035, ShortsMetadata1791763200000, ShortsUploads1791763202000,
      ShortsCatalog1791763211000, ShortsUploadBudget1791763224000, ShortsFollowing1791763227000] };
  const db = new DataSource(options), other = new DataSource(options);
  await db.initialize(); await other.initialize();
  t.after(async () => { await other.destroy(); await db.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await db.runMigrations();
  const metadata = new ShortsMetadataService(db), writer = new ShortsMetadataService(other);
  await metadata.initialize(scope, hash);
  await metadata.configureUploadBudget(scope, { uploads: 300, sourceBytes: 100000 });
  await db.query('INSERT INTO social_graph_projection_scopes(network,contract,generation,state) VALUES($1,$2,$3,$4)', [graph.network, graph.contract, graph.generation, 'ready']);
  const projector = new SocialGraphProjectionService(other);
  let eventIndex = 0;
  const edge = (from, to, kind, present) => projector.applyEvent(graph,
    { transaction: `th_event${++eventIndex}`, index: 0, height: '100' }, [{ from, to, kind, present }]);
  const clips = [];
  for (let i = 0; i < 244; i++) {
    const record = { id: `clip-${String(i).padStart(4, '0')}`, creator: i < 44 ? (i % 2 ? 'ak_one' : 'ak_two') : 'ak_unrelated',
      title: `Short ${i}`, topic: 'Art', createdAt: 1000 + Math.floor(i / 3), cid: `bafy${i}`, bytes: 123, duration: 10,
      moderation: 'pending', safety: { status: 'no_flags' }, views: [], reports: 0,
      files: [{ name: 'video.mp4', bytes: 123, sha256: hash }], privateMedia: { private: true } };
    await writer.insertDraft(scope, record, 300);
    await writer.change(scope, record.id, s => { s.publication = 'published'; s.moderation = 'approved'; });
    clips.push(record);
  }
  await edge(viewer, 'ak_one', 'follow', true); await edge(viewer, 'ak_two', 'follow', true);
  const chain = { release: { network: scope.network, contract: scope.contract }, state: { ...scope, sourceHash: hash, shorts: [] }, readNode: work => work(),
    address: value => { if (typeof value !== 'string' || !/^ak_[a-z]+$/.test(value)) throw new BadRequestException(); return value; },
    read: async (method, args) => {
      if (method === 'has_liked') return false;
      const s = clips.find(row => row.id === args[0]);
      return s && { cid: s.cid, creator: s.creator, size: BigInt(s.bytes), likes: 1n };
    } };
  const following = new ShortsFollowingService(db, chain);
  following.reader = { identity: { network: graph.network, contract: graph.contract }, verifyIdentity: async () => {} };
  const records = new ShortsRecordsService(chain, metadata);
  records.all = () => assert.fail('No full registry read');
  const api = new ShortsService(chain, {}, { counters: async () => ({ views: 1 }) }, {}, {}, {}, {}, {}, records, undefined, undefined, following);

  await t.test('older followed videos page across creators with stable ties, no unrelated/private fields', async () => {
    assert.ok((await api.catalog()).items.every(s => s.creator === 'ak_unrelated'));
    let cursor, ids = [];
    do {
      const page = await api.followingCatalog(viewer, cursor);
      assert.ok(page.items.length <= 20); assert.match(page.revision, /^[a-f0-9]{64}$/);
      assert.ok(page.items.every(s => ['ak_one', 'ak_two'].includes(s.creator) && !('privateMedia' in s) && !('files' in s)));
      ids.push(...page.items.map(s => s.id)); cursor = page.next ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 44); assert.equal(new Set(ids).size, 44); assert.ok(ids.includes('clip-0000'));
    assert.deepEqual(ids, clips.slice(0, 44).reverse().map(s => s.id));
    const indices = await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='shorts_content_following_page'", [schema]);
    assert.match(indices[0].indexdef, /creator, created_at DESC, id DESC/); assert.match(indices[0].indexdef, /WHERE/);
  });
  await t.test('cursors bind viewer, deployment, source hash and membership; dirty acknowledgements do not invalidate', async () => {
    const page = await following.page(scope, hash, viewer);
    await assert.rejects(following.page(scope, hash, 'ak_other', page.next), { status: 400 });
    await assert.rejects(following.page({ ...scope, contract: 'ct_other' }, hash, viewer, page.next), { status: 400 });
    await assert.rejects(following.page(scope, 'b'.repeat(64), viewer, page.next), { status: 400 });
    await other.query('DELETE FROM social_graph_projection_dirty');
    assert.equal((await following.page(scope, hash, viewer)).revision, page.revision);
    await edge(viewer, 'ak_one', 'follow', false);
    await assert.rejects(following.page(scope, hash, viewer, page.next), { status: 400 });
    assert.ok((await api.followingCatalog(viewer)).items.every(s => s.creator === 'ak_two'));
    await edge(viewer, 'ak_one', 'follow', true);
    assert.notEqual((await following.page(scope, hash, viewer)).revision, page.revision);
  });
  await t.test('both block directions exclude creators; bounded state rechecks remove unfollowed videos', async () => {
    await edge(viewer, 'ak_one', 'block', true);
    assert.ok((await api.followingCatalog(viewer)).items.every(s => s.creator === 'ak_two'));
    await edge('ak_two', viewer, 'block', true);
    assert.deepEqual((await api.followingCatalog(viewer)).items, []);
    assert.deepEqual((await api.catalogState(viewer, ['clip-0000', 'clip-0001'], true)).items, []);
    await edge(viewer, 'ak_one', 'block', false); await edge('ak_two', viewer, 'block', false);
    const before = await api.catalogState(viewer, ['clip-0000', 'clip-0001'], true);
    await edge(viewer, 'ak_one', 'follow', false);
    const after = await api.catalogState(viewer, ['clip-0000', 'clip-0001'], true);
    assert.deepEqual(after.items.map(s => s.id), ['clip-0000']); assert.notEqual(after.revision, before.revision);
    await edge(viewer, 'ak_one', 'follow', true);
  });
  await t.test('current public policy still excludes pending, withdrawn, rejected and scanner-error content', async () => {
    await writer.change(scope, 'clip-0043', s => { s.publication = undefined; });
    await writer.change(scope, 'clip-0042', s => { s.publication = 'withdrawn'; });
    await writer.change(scope, 'clip-0041', s => { s.moderation = 'rejected'; });
    await writer.change(scope, 'clip-0040', s => { s.safety = { status: 'error' }; });
    const ids = (await api.followingCatalog(viewer)).items.map(s => s.id);
    assert.ok(['clip-0043', 'clip-0042', 'clip-0041', 'clip-0040'].every(id => !ids.includes(id)));
    assert.deepEqual((await api.catalogState(viewer, ['clip-0043', 'clip-0042', 'clip-0041', 'clip-0040'], true)).items, []);
  });
  await t.test('an unfollow committed during chain IO invalidates the page rather than returning stale candidates', async () => {
    const read = chain.read; let changed = false;
    chain.read = async (...args) => { if (!changed) { changed = true; await edge(viewer, 'ak_one', 'follow', false); } return read(...args); };
    await assert.rejects(api.followingCatalog(viewer), { status: 409 });
    chain.read = read; await edge(viewer, 'ak_one', 'follow', true);
  });
  await t.test('newest generation controls availability and numeric generation ordering; old scopes cannot recheck', async () => {
    await other.query("INSERT INTO social_graph_projection_scopes(network,contract,generation,state) VALUES($1,$2,10,'rebuilding')", [graph.network, graph.contract]);
    await assert.rejects(api.followingCatalog(viewer), { status: 503 });
    await assert.rejects(api.catalogState(viewer, [], true), { status: 503 });
    await other.query("UPDATE social_graph_projection_scopes SET state='ready' WHERE generation=10");
    assert.deepEqual((await api.followingCatalog(viewer)).items, []);
    await assert.rejects(following.creators(graph, viewer, ['ak_one']), { status: 503 });
    await other.query('DELETE FROM social_graph_projection_scopes WHERE generation=10');
  });
  await t.test('HTTP Following is uncached, bounded and read-only; missing viewer and oversized windows reject', async () => {
    const app = await NestFactory.create({ module: class FollowingTestModule {}, controllers: [ShortsController],
      providers: [ShortsAuthGuard, ShortsUploadInterceptor, { provide: ShortsAuthService, useValue: {} },
        { provide: ShortsService, useValue: api }, { provide: ShortsUploadsService, useValue: {} }],
    }, { logger: false });
    try {
      await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/shorts/feed/following`;
      assert.equal((await fetch(base)).status, 400);
      assert.equal((await fetch(`${base}?address=a&address=b`)).status, 400);
      const response = await fetch(`${base}?address=${viewer}`);
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const page = await response.json(); assert.ok(page.items.length <= 20); assert.ok(page.next);
      assert.equal((await fetch(`${base}?address=${viewer}&cursor=a&cursor=b`)).status, 400);
      const state = await fetch(`${base}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: viewer, ids: [] }) });
      assert.equal(state.status, 200); assert.equal(state.headers.get('cache-control'), 'no-store');
      assert.match((await state.json()).revision, /^[a-f0-9]{64}$/);
      const tooMany = await fetch(`${base}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: viewer, ids: clips.slice(0, 21).map(s => s.id) }) });
      assert.equal(tooMany.status, 400);
    } finally { await app.close(); }
  });
});

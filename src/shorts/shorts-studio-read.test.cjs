require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsAnalytics1791763207000 } = require('../migrations/1791763207000-ShortsAnalytics');
const { ShortsChainIndex1791676800000 } = require('../migrations/1791676800000-ShortsChainIndex');
const { ShortsCoverage1791734400000 } = require('../migrations/1791734400000-ShortsCoverage');
const { ShortsStudio1791763212000 } = require('../migrations/1791763212000-ShortsStudio');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsMeasurementsService } = require('./shorts-measurements.service');
const { ShortsIndexService, SHORTS_INDEX_VERSION } = require('./shorts-index.service');
const { ShortsStudioReadService } = require('./shorts-studio-read.service');
const { ShortsService } = require('./shorts.service');
const { studioQuery, studioCursor } = require('./shorts-studio-query');

test('Studio filter/cursor validation binds deployment, creator, filters and period', () => {
  const q = studioQuery({ q: ' Art ', days: '7' }), scope = ['ae_uat', 'ct_current', 'source', 'ak_creator'];
  const c = studioCursor(scope, q).encode({ value: 5, at: 100, id: 'video' }, 'previous');
  assert.deepEqual(studioCursor(scope, { ...q, cursor: c }).position, { value: 5, at: 100, id: 'video' });
  for (const input of [{ q: [] }, { q: 'a'.repeat(101) }, { q: '\0' }, { sort: 'DROP TABLE' }, { status: 'other' }, { days: [7] }, { days: 1 }, { cursor: [] }]) assert.throws(() => studioQuery(input), { status: 400 });
  for (const patch of [{ q: 'different' }, { days: 28 }, { sort: 'views' }, { status: 'published' }]) assert.throws(() => studioCursor(scope, { ...q, ...patch, cursor: c }), { status: 400 });
  assert.throws(() => studioCursor([...scope, 'different'], { ...q, cursor: c }), { status: 400 });
  for (const cursor of ['', 'a'.repeat(769), `${c}=`, 'not-json']) assert.throws(() => studioCursor(scope, { ...q, cursor }), { status: 400 });
});

test('Studio read model: complete counts, global sorts, canonical rollback and bounded private HTTP', { skip: !process.env.SHORTS_TEST_PG_URL, timeout: 90000 }, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_studio_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 6 } };
  const db = new DataSource(options), second = new DataSource(options);
  await db.initialize(); await second.initialize();
  t.after(async () => { await second.destroy(); await db.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await db.query(`CREATE TABLE txs(hash varchar PRIMARY KEY,type text,contract_id text,data jsonb,raw jsonb);
    CREATE TABLE sync_state(id text PRIMARY KEY,tip_height int,updated_at timestamptz);
    CREATE TABLE plugin_failed_transaction(plugin_name text,tx_hash varchar);
    INSERT INTO sync_state VALUES('global',20,now());`);
  for (const Migration of [ShortsChainIndex1791676800000, ShortsCoverage1791734400000, ShortsMetadata1791763200000, ShortsAnalytics1791763207000, ShortsStudio1791763212000]) await new Migration().up({ query: (sql, args) => db.query(sql, args) });
  const scope = { network: 'ae_uat', contract: 'ct_current' }, hash = 'a'.repeat(64);
  const chain = { release: { schemaVersion: 1, network: 'ae_uat', contract: scope.contract }, rewardContracts: () => [], state: { contract: scope.contract, sourceHash: hash }, contract: { $options: { address: scope.contract } },
    address: value => value, account: async address => ({ address, available: '1', earned: '2', claimed: '1' }),
    read: () => { throw new Error('Per-video chain RPC is forbidden in Studio queries'); } };
  const index = new ShortsIndexService(db, chain, await require('./testing/index-network.cjs').indexNetworkFixture(db, chain)), reader = new ShortsStudioReadService(db, chain, index);
  const meta = new ShortsMetadataService(db), measurements = new ShortsMeasurementsService(db);
  await meta.initialize(scope, hash); await measurements.initialize(scope, hash);
  await db.query("INSERT INTO shorts_index_backfill(contract,version,complete,covered_height) VALUES('ct_current',$1,true,1000)", [SHORTS_INDEX_VERSION]);
  await db.query("INSERT INTO txs(hash,type,contract_id,data) VALUES('th_all','ContractCallTx','ct_current',$1),('th_pending','ContractCallTx','ct_current',$1)", [JSON.stringify({ shorts: { _version: SHORTS_INDEX_VERSION } })]);
  const rows = Array.from({ length: 126 }, (_, i) => ({ i, id: `clip-${String(i).padStart(6, '0')}`, creator: i < 121 ? 'ak_creator' : 'ak_other',
    at: 1700000000000 + Math.floor(i / 3), likes: i % 7, periodViews: i % 5,
    status: ['published', 'draft', 'withdrawn'][i % 3], restricted: i % 11 === 0 && i % 3 !== 2 }));
  // Large deterministic fixture deliberately bypasses normal 50-video admission.
  for (const r of rows) await db.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,$5,$6)`,
    [scope.network, scope.contract, r.id, r.creator, r.at, JSON.stringify({ id: r.id, creator: r.creator, createdAt: r.at,
      title: r.i === 100 ? 'Art 100% ready' : `Clip ${r.i}`, topic: 'Art', cid: 'bafyfixture', bytes: 10, duration: 10,
      publication: r.i % 3 === 1 ? undefined : 'published', moderation: r.i % 11 === 0 ? 'rejected' : 'approved',
      files: [{ name: 'private-source.mp4' }], privateMedia: { secret: 'private-key' }, reports: 0, views: [] })]);
  for (const r of rows) {
    const events = [];
    if (r.i % 3 !== 1) events.push('Published');
    if (r.i % 3 === 2) events.push('Withdrawn');
    events.push(...Array.from({ length: r.likes }, () => 'PaidLike'));
    for (const [i, action] of events.entries()) await db.query('INSERT INTO shorts_chain_events VALUES($1,$2,$3,10,1700000000000,$4,$5,$5,0,$6)',
      [scope.contract, 'th_all', r.i * 20 + i, action, r.creator, r.id]);
  }
  const now = Date.now(), start = now - 86400000, day = Math.floor(start / 86400000);
  for (let j = 0; j < 4; j++) {
    const viewer = String(j).padStart(64, 'f');
    await db.query('INSERT INTO shorts_measurement_viewers VALUES($1,$2,$3,$4,0)', [scope.network, scope.contract, viewer, now]);
    for (const r of rows.filter(r => r.periodViews > j)) await db.query('INSERT INTO shorts_measurement_plays VALUES($1,$2,$3,$4,$5,$6,$7,5,10,$8)',
      [scope.network, scope.contract, `event-${r.id}-${j}`, r.id, viewer, start, day, 'for-you']);
  }
  const owned = rows.filter(r => r.creator === 'ak_creator');
  const counts = { all: 121, published: 41, draft: 40, withdrawn: 40, restricted: owned.filter(r => r.restricted).length, firstRestricted: owned.filter(r => r.restricted).at(-1).id };
  await t.test('all six sorts page the complete library in both directions without duplicate ties', async () => {
    for (const sort of ['newest', 'oldest', 'likes', 'likes-asc', 'views', 'views-asc']) {
      const ascending = sort === 'oldest' || sort.endsWith('-asc');
      const rank = r => sort.startsWith('likes') ? r.likes : sort.startsWith('views') ? r.periodViews : r.at;
      const expected = [...owned].sort((a, b) => (rank(a) - rank(b) || a.at - b.at || a.id.localeCompare(b.id)) * (ascending ? 1 : -1));
      const pages = []; let cursor;
      do { const page = await reader.page('ak_creator', { sort, cursor }); pages.push(page); cursor = page.next ?? undefined; } while (cursor);
      assert.deepEqual(pages.flatMap(p => p.items.map(r => r.record.id)), expected.map(r => r.id));
      assert.ok(pages.every(p => p.items.length <= 20 && p.total === 121 && !p.index.stale));
      assert.deepEqual(pages[0].counts, counts); assert.equal(pages[0].previous, null);
      for (let i = pages.length - 1; i > 0; i--) {
        const prior = await reader.page('ak_creator', { sort, cursor: pages[i].previous });
        assert.deepEqual(prior.items.map(r => r.record.id), pages[i - 1].items.map(r => r.record.id));
      }
    }
  });
  await t.test('search is literal, filters are global, and selected IDs cannot choose another creator', async () => {
    const page = await reader.page('ak_creator', { q: '100%' });
    assert.deepEqual(page.items.map(r => r.record.id), [rows[100].id]); assert.equal(page.total, 1); assert.deepEqual(page.counts, counts);
    const draft = await reader.page('ak_creator', { status: 'draft', q: 'Art' }); assert.equal(draft.total, 40);
    assert.ok(draft.items.every(r => r.publication === 'draft'));
    assert.deepEqual((await reader.page('ak_creator', {}, { ids: [rows[125].id] })).items, []);
    assert.equal((await reader.page('ak_empty', {})).counts.all, 0);
    assert.equal((await reader.page('ak_other', {})).counts.all, 5);
    await assert.rejects(reader.page('ak_other', { cursor: draft.next, q: 'Art', status: 'draft' }), { status: 400 });
    await assert.rejects(reader.page('ak_creator', {}, { limit: 100 }), { status: 400 });
  });
  await t.test('canonical confirmations and FK reorg rollback drive status and freshness', async () => {
    await db.query("INSERT INTO shorts_chain_events VALUES('ct_current','th_pending',0,19,1700000001000,'Withdrawn','ak_creator','ak_creator',0,$1)", [rows[0].id]);
    const read = () => reader.page('ak_creator', {}, { ids: [rows[0].id] });
    assert.equal((await read()).items[0].publication, 'published');
    await second.query("UPDATE sync_state SET tip_height=21 WHERE id='global'");
    assert.equal((await read()).items[0].publication, 'withdrawn');
    await second.query("DELETE FROM txs WHERE hash='th_pending'");
    assert.equal((await read()).items[0].publication, 'published');
    await db.query("UPDATE sync_state SET updated_at=now()-interval '3 minutes'"); assert.equal((await read()).index.stale, true);
    await db.query("UPDATE sync_state SET updated_at=now(); UPDATE shorts_index_backfill SET complete=false"); assert.equal((await read()).index.stale, true);
    await db.query('UPDATE shorts_index_backfill SET complete=true');
    await db.query("INSERT INTO plugin_failed_transaction VALUES('shorts','th_failure')"); assert.equal((await read()).index.stale, true);
    await db.query('DELETE FROM plugin_failed_transaction'); assert.equal((await read()).index.stale, false);
  });
  await t.test('authenticated HTTP returns bounded safe cards and independent account/top-video data', async t => {
    const { NestFactory } = require('@nestjs/core'); const { UnauthorizedException } = require('@nestjs/common');
    const { ShortsController } = require('./shorts.controller'); const { ShortsAuthService } = require('./shorts-auth.service');
    const { ShortsAuthGuard } = require('./shorts-auth.guard'); const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
    const { ShortsUploadsService } = require('./shorts-uploads.service');
    const analytics = { creatorReport: (creator, days, id) => measurements.creatorReport(scope, creator, days, id) };
    const service = new ShortsService(chain, {}, analytics, index, {}, {}, {}, {}, { shared: true, all: () => { throw new Error('Whole library read'); } }, undefined, reader);
    const app = await NestFactory.create({ module: class StudioHttpTest {}, controllers: [ShortsController], providers: [ShortsAuthGuard, ShortsUploadInterceptor,
      { provide: ShortsService, useValue: service }, { provide: ShortsUploadsService, useValue: {} },
      { provide: ShortsAuthService, useValue: { authenticate: async auth => { if (auth !== 'Bearer creator') throw new UnauthorizedException(); return 'ak_creator'; } } },
    ] }, { logger: false }); await app.listen(0, '127.0.0.1'); t.after(() => app.close());
    const base = await app.getUrl(), get = path => fetch(`${base}/shorts${path}`, { headers: { authorization: 'Bearer creator' } });
    const response = await get('/studio/content?address=ak_other'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.json(); assert.equal(page.items.length, 20); assert.equal(page.counts.all, 121);
    assert.ok(page.items.every(r => r.creator === 'ak_creator' && r.mine)); assert.ok(!JSON.stringify(page).includes('private-source')); assert.ok(!JSON.stringify(page).includes('private-key'));
    const summary = await (await get('/studio/summary')).json(); assert.equal(summary.shorts.length, 4); assert.equal(summary.account.available, '1'); assert.equal(summary.library.all, 121);
    const detail = await (await get(`/studio/video/${rows[0].id}`)).json(); assert.equal(detail.video.id, rows[0].id);
    assert.equal((await get(`/studio/video/${rows[125].id}`)).status, 404);
    assert.equal((await fetch(`${base}/shorts/studio/content`)).status, 401);
    const performance = await (await get('/performance?days=28')).json(); assert.equal(performance.topShorts.length, 5);
    assert.equal(performance.summary.views, owned.reduce((n, r) => n + r.periodViews, 0));
    assert.ok(performance.topShorts.every(r => r.creator === 'ak_creator' && performance.videos[r.id].views === 4));
  });
  await t.test('V2 retains media analytics and combines imported memberships once with only new V2 events', async () => {
    const { ShortsReceipts1791763208000 } = require('../migrations/1791763208000-ShortsReceipts');
    const { ShortsImportSnapshot1792368001000 } = require('../migrations/1792368001000-ShortsImportSnapshot');
    const runner = { query: (sql, args) => db.query(sql, args) };
    await new ShortsReceipts1791763208000().up(runner); await new ShortsImportSnapshot1792368001000().up(runner);
    await meta.initialize({ network: 'ae_uat', contract: 'ct_vtwo' }, 'b'.repeat(64));
    await db.query("INSERT INTO shorts_import_snapshots(network,contract,source,cutoff_hash,cutoff_height,digest,videos,likes) VALUES('ae_uat','ct_vtwo','ct_current','kh_cutoff',5,$1,3,7)", ['c'.repeat(64)]);
    await db.query("INSERT INTO shorts_import_videos(network,contract,id,likes,withdrawn) VALUES('ae_uat','ct_vtwo',$1,7,false),('ae_uat','ct_vtwo',$2,0,true),('ae_uat','ct_vtwo',$3,0,false)", [rows[3].id, rows[6].id, rows[0].id]);
    await db.query("INSERT INTO txs(hash,type,contract_id,data) VALUES('th_vtwo','ContractCallTx','ct_vtwo',$1)", [JSON.stringify({ shorts: { _version: SHORTS_INDEX_VERSION } })]);
    for (let n = 0; n < 2; n++) await db.query("INSERT INTO shorts_chain_events VALUES('ct_vtwo','th_vtwo',$1,10,1700000000000,'PaidLike','ak_viewer','ak_creator',17,$2)", [n, rows[3].id]);
    const chain2 = { ...chain, release: { schemaVersion: 2, network: 'ae_uat', contract: 'ct_vtwo', sourceHash: 'b'.repeat(64), storage: { contract: scope.contract, sourceHash: hash } }, state: { contract: 'ct_vtwo', sourceHash: 'b'.repeat(64) } };
    const v2 = new ShortsStudioReadService(db, chain2, { assertNetwork: async () => {}, health: async () => ({ height: 21, stale: false }) });
    const page = await v2.page('ak_creator', { sort: 'likes' }, { ids: [rows[3].id, rows[6].id, rows[0].id] });
    assert.equal(page.items[0].record.id, rows[3].id); assert.equal(page.items[0].likes, 9); assert.equal(page.items[0].periodViews, 3); assert.equal(page.items[0].publication, 'published');
    assert.equal(page.items.find(r => r.record.id === rows[6].id).publication, 'withdrawn');
    await db.query("INSERT INTO shorts_chain_events VALUES('ct_vtwo','th_vtwo',2,10,1700000000000,'Withdrawn','ak_creator','ak_creator',0,$1)", [rows[0].id]);
    assert.equal((await v2.page('ak_creator', {}, { ids: [rows[0].id] })).items[0].publication, 'withdrawn');
    // Historical rewards still retain every original payment, independent of membership deduplication.
    assert.equal(Number((await db.query("SELECT count(*) FROM shorts_chain_events WHERE contract='ct_current' AND action='PaidLike' AND short_id=$1", [rows[3].id]))[0].count), 3);
  });
  const migration = new ShortsStudio1791763212000(); await migration.down({ query: (sql, args) => db.query(sql, args) });
  assert.equal((await db.query("SELECT to_regclass('shorts_chain_events_video') AS name"))[0].name, null);
});

require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataSource } = require('typeorm');
const { DatabaseSync } = require('node:sqlite');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsAnalytics1791763207000 } = require('../migrations/1791763207000-ShortsAnalytics');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsMeasurementsService } = require('./shorts-measurements.service');
const { ShortsHostedAnalyticsService } = require('./shorts-hosted-analytics.service');
const { LocalShortsAnalyticsService, playbackSummary, ANALYTICS_DAY: DAY } = require('./shorts-analytics.service');
const { legacyAnalytics } = require('./shorts-analytics-legacy');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('shared analytics and privacy: consistent counts, deletion, bounded reports and explicit migration', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 90000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const schema = `shorts_metrics_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 },
    migrations: [ShortsMetadata1791763200000, ShortsAnalytics1791763207000] };
  const one = new DataSource(options), two = new DataSource(options); const locals = [], services = [];
  const env = { ...process.env };
  t.after(async () => {
    process.env = env; for (const service of services) await service.onModuleDestroy();
    for (const db of locals) db.close(); await two.destroy(); await one.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy();
  });
  await one.initialize(); await two.initialize(); await one.runMigrations({ transaction: 'all' });
  const a = new ShortsMeasurementsService(one), b = new ShortsMeasurementsService(two), meta = new ShortsMetadataService(one);
  const hash = 'a'.repeat(64), params = s => [s.network, s.contract];
  async function scope(initialize = true) {
    const s = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` };
    await meta.initialize(s, hash); if (initialize) await a.initialize(s, hash); return s;
  }
  async function video(s, id = randomUUID(), duration = 10) {
    await meta.insertDraft(s, { id, creator: 'ak_creator', cid: 'bafyfixture', bytes: 10, duration,
      createdAt: Date.now(), title: 'Owned clip', topic: 'Art', moderation: 'pending', views: [], reports: 0,
      files: [{ name: 'video.mp4', bytes: 10, sha256: hash }] }); return id;
  }
  const event = (session = randomUUID()) => ({ id: randomUUID(), session, seconds: 0, source: 'for-you' });
  async function elapsed(s, id, ms = 6000) {
    await one.query(`UPDATE shorts_measurement_plays SET started=$4,day=$5 WHERE network=$1 AND contract=$2 AND id=$3`,
      [...params(s), id, Date.now() - ms, Math.floor((Date.now() - ms) / DAY)]);
  }
  async function raw(s, table) { return one.query(`SELECT * FROM ${table} WHERE network=$1 AND contract=$2`, params(s)); }
  function local() {
    const db = new DatabaseSync(':memory:'); locals.push(db); const store = { db }; new LocalShortsAnalyticsService(store); return store;
  }
  // Elapsed-time tests stay away from the UTC reset rather than faking the database clock.
  if (Date.now() % DAY < 10000) await sleep(10010 - Date.now() % DAY);

  await t.test('two instances share one salt/start date and reject mismatched deployment identity', async () => {
    const s = await scope(false);
    const starts = await Promise.all([a.initialize(s, hash), b.initialize(s, hash)]);
    assert.equal(starts[0], starts[1]); assert.equal((await raw(s, 'shorts_measurement_settings')).length, 1);
    await assert.rejects(b.initialize(s, 'b'.repeat(64)), { status: 503 });
    const different = await scope();
    assert.notEqual((await raw(s, 'shorts_measurement_settings'))[0].salt, (await raw(different, 'shorts_measurement_settings'))[0].salt);
    const id = await video(s), e = event(); await a.record(s, id, e);
    const stored = (await raw(s, 'shorts_measurement_plays'))[0];
    assert.match(stored.viewer, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(stored).includes(e.session));
    assert.equal((await b.counters(different, id)).views, 0);
  });
  await t.test('concurrent playback advances monotonically and increments views exactly once', async () => {
    const s = await scope(), id = await video(s), e = event();
    await a.record(s, id, { ...e, seconds: 65 });
    assert.equal((await b.counters(s, id)).views, 0, 'first report cannot claim an instant completed view');
    await elapsed(s, e.id);
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).record(s, id, { ...e, seconds: i % 2 ? 10 : 2 })));
    assert.equal((await a.counters(s, id)).views, 1);
    const [play] = await raw(s, 'shorts_measurement_plays'); assert.ok(play.seconds >= 6 && play.seconds < 8);
    assert.equal(await b.record(s, id, { ...event(e.session), seconds: 10 }), false);
    await assert.rejects(b.record(s, id, { ...e, session: randomUUID() }), { status: 400 });
    await assert.rejects(a.record(s, id, { ...e, seconds: Infinity }), { status: 400 });
    const other = await video(s); await assert.rejects(b.record(s, other, e), { status: 400 });
    const different = await scope(); await video(different, id); assert.equal(await b.record(different, id, e), true);
  });
  await t.test('verified first events ignore sub-threshold writes and serialize across replicas', async () => {
    const s = await scope(), id = await video(s), session = randomUUID(), start = Date.now() - 6000;
    for (const seconds of [0, 1.5]) {
      assert.equal(await a.record(s, id, { ...event(), seconds }, start), true);
      assert.equal(await b.record(s, id, { ...event(), seconds }, start), true);
    }
    assert.equal((await raw(s, 'shorts_measurement_viewers')).length, 0);
    assert.equal((await raw(s, 'shorts_measurement_plays')).length, 0);
    const events = Array.from({ length: 8 }, () => ({ ...event(session), seconds: 4 }));
    const accepted = await Promise.all(events.map((e, i) => (i % 2 ? a : b).record(s, id, e, start)));
    assert.equal(accepted.filter(Boolean).length, 1);
    assert.equal((await b.counters(s, id)).views, 1);
    assert.equal((await raw(s, 'shorts_measurement_viewers')).length, 1);
    const [play] = await raw(s, 'shorts_measurement_plays');
    assert.equal(Number(play.started), start); assert.equal(play.seconds, 4);
    await a.forget(s, session);
    assert.equal(await b.record(s, id, events[0], start), false);
    assert.equal((await raw(s, 'shorts_measurement_plays')).length, 0);
  });
  await t.test('different event IDs racing for the same browser/video/day cannot double count', async () => {
    const s = await scope(), id = await video(s), session = randomUUID();
    const events = Array.from({ length: 8 }, () => event(session));
    const accepted = await Promise.all(events.map((e, i) => (i % 2 ? a : b).record(s, id, e)));
    assert.equal(accepted.filter(Boolean).length, 1); assert.equal((await raw(s, 'shorts_measurement_plays')).length, 1);
    const e = events[accepted.indexOf(true)]; await elapsed(s, e.id);
    await b.record(s, id, { ...e, seconds: 4 }); assert.equal((await a.counters(s, id)).views, 1);
    await elapsed(s, e.id, DAY + 6000);
    assert.equal(await a.record(s, id, { ...e, seconds: 10 }), false);
    const tomorrow = event(session); await a.record(s, id, tomorrow); await elapsed(s, tomorrow.id);
    await b.record(s, id, { ...tomorrow, seconds: 3 }); assert.equal((await a.counters(s, id)).views, 2);
  });
  await t.test('deletion serializes with concurrent measurement and prevents replay across restarts', async () => {
    const s = await scope(), id = await video(s), e = event(); await a.record(s, id, e); await elapsed(s, e.id);
    await a.record(s, id, { ...e, seconds: 5 });
    const outcome = await Promise.all([a.record(s, id, { ...e, seconds: 10 }), b.forget(s, e.session)]);
    assert.deepEqual(outcome[1], { deleted: true });
    assert.equal((await raw(s, 'shorts_measurement_plays')).length, 0); assert.equal((await a.counters(s, id)).views, 0);
    const restarted = new ShortsMeasurementsService(two); await restarted.initialize(s, hash);
    assert.equal(await restarted.record(s, id, event(e.session)), false);
    await a.forget(s, e.session); assert.equal((await b.counters(s, id)).views, 0);
    assert.equal((await b.report(s, [id], 7)).summary.views, 0);
    const other = event(); await restarted.record(s, id, other); await elapsed(s, other.id); await a.record(s, id, { ...other, seconds: 4 });
    assert.equal((await b.counters(s, id)).views, 1);
  });
  await t.test('database clock after a privacy-lock wait determines the replay barrier', async () => {
    const s = await scope(), id = await video(s), e = event(); await a.forget(s, e.session);
    await one.query('UPDATE shorts_measurement_viewers SET forgotten_until=$3 WHERE network=$1 AND contract=$2', [...params(s), Date.now() + 500]);
    const runner = one.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    try {
      await runner.query('SELECT viewer FROM shorts_measurement_viewers WHERE contract=$1 FOR UPDATE', [s.contract]);
      const pending = b.record(s, id, e); await sleep(600); await runner.commitTransaction();
      assert.equal(await pending, true, 'a legitimately expired marker does not depend on a stale process clock');
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });
  await t.test('failed count or deletion commits roll back every affected row and remain retryable', async () => {
    const s = await scope(), id = await video(s), e = event(); await a.record(s, id, e); await elapsed(s, e.id);
    await one.query(`ALTER TABLE shorts_measurement_totals ADD CONSTRAINT measurement_test_fail CHECK(contract<>'${s.contract}' OR views=0)`);
    try {
      await assert.rejects(b.record(s, id, { ...e, seconds: 5 }), { code: '23514' });
      assert.equal((await raw(s, 'shorts_measurement_plays'))[0].seconds, 0);
      assert.equal((await b.counters(s, id)).views, 0);
    } finally { await one.query('ALTER TABLE shorts_measurement_totals DROP CONSTRAINT measurement_test_fail'); }
    await a.record(s, id, { ...e, seconds: 5 }); assert.equal((await b.counters(s, id)).views, 1);
    await one.query(`ALTER TABLE shorts_measurement_viewers ADD CONSTRAINT privacy_test_fail CHECK(contract<>'${s.contract}' OR forgotten_until=0)`);
    try {
      await assert.rejects(b.forget(s, e.session), { code: '23514' });
      assert.equal((await raw(s, 'shorts_measurement_plays')).length, 1);
      assert.equal((await b.counters(s, id)).views, 1);
    } finally { await one.query('ALTER TABLE shorts_measurement_viewers DROP CONSTRAINT privacy_test_fail'); }
    await a.forget(s, e.session); assert.equal((await b.counters(s, id)).views, 0);
  });
  await t.test('per-browser admission applies across instances while existing progress remains retryable', async () => {
    const s = await scope(), id = await video(s), extra = await video(s), e = event(); await a.record(s, id, e);
    const viewer = (await raw(s, 'shorts_measurement_plays'))[0].viewer;
    // Distinct videos emulate a browser that has already reached the rolling limit.
    await one.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body)
      SELECT $1,$2,'limit-'||i,'ak_creator',0,jsonb_build_object('id','limit-'||i,'creator','ak_creator','duration',10)
      FROM generate_series(1,999) i`, params(s));
    const now = Date.now(), day = Math.floor(now / DAY);
    await one.query(`INSERT INTO shorts_measurement_plays SELECT $1,$2,'limit-event-'||lpad(i::text,20,'0'),
      'limit-'||i,$3,$4,$5,0,10,'recent' FROM generate_series(1,999) i`, [...params(s), viewer, now, day]);
    await assert.rejects(b.record(s, extra, event(e.session)), /Playback limit/);
    await elapsed(s, e.id); assert.equal(await b.record(s, id, { ...e, seconds: 3 }), true);
  });
  await t.test('legacy import preserves salt/totals/deletions and never resurrects data on the next bootstrap', async () => {
    const s = await scope(false), id = await video(s), store = local(), session = randomUUID();
    const salt = store.db.prepare('SELECT salt FROM shorts_analytics_settings').get().salt;
    const viewer = createHash('sha256').update(`${salt}:${session}`).digest('hex'), now = Date.now();
    store.db.prepare('INSERT INTO shorts_plays VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, viewer, now - 6000, 5, 'shared', 10);
    store.db.prepare('INSERT INTO shorts_view_totals VALUES(?,?)').run(id, 7);
    const forgotten = randomUUID(), forgottenHash = createHash('sha256').update(`${salt}:${forgotten}`).digest('hex');
    store.db.prepare('INSERT INTO shorts_forgotten_viewers VALUES(?,?)').run(forgottenHash, now + DAY);
    const legacy = legacyAnalytics(store);
    await assert.rejects(a.initialize(s, hash, legacy), { status: 409 });
    assert.equal((await raw(s, 'shorts_measurement_settings')).length, 0);
    await a.initialize(s, hash, legacy, true); assert.equal((await b.counters(s, id)).views, 7);
    assert.equal(await b.record(s, id, event(forgotten)), false);
    await b.forget(s, session); assert.equal((await a.counters(s, id)).views, 6);
    await a.initialize(s, hash, legacyAnalytics(store));
    assert.equal((await raw(s, 'shorts_measurement_plays')).length, 0); assert.equal((await a.counters(s, id)).views, 6);
    store.db.prepare('UPDATE shorts_view_totals SET views=8').run();
    await assert.rejects(a.initialize(s, hash, legacyAnalytics(store), true), { status: 409 });
    assert.equal((await a.counters(s, id)).views, 6);
  });
  await t.test('a paged legacy import rolls back on invalid data and refuses a nonempty destination', async () => {
    const s = await scope(false), id = await video(s), store = local(), now = Date.now();
    const insert = store.db.prepare('INSERT INTO shorts_plays VALUES(?,?,?,?,?,?,?)');
    for (let i = 0; i < 1002; i++) insert.run(`event-${String(i).padStart(20, '0')}`, id, createHash('sha256').update(String(i)).digest('hex'), now - 6000, 5, 'recent', i === 1001 ? 0 : 10);
    store.db.prepare('INSERT INTO shorts_view_totals VALUES(?,?)').run(id, 1002);
    await assert.rejects(a.initialize(s, hash, legacyAnalytics(store), true), /Invalid legacy playback/);
    assert.equal((await raw(s, 'shorts_measurement_settings')).length, 0); assert.equal((await raw(s, 'shorts_measurement_plays')).length, 0);
    store.db.exec('UPDATE shorts_plays SET duration=10');
    await a.initialize(s, hash, legacyAnalytics(store), true); assert.equal((await b.counters(s, id)).views, 1002);
    const other = await scope(); await video(other, id);
    await assert.rejects(b.initialize(other, hash, legacyAnalytics(store), true), { status: 409 });
  });
  await t.test('SQL aggregation matches playback metrics, previous periods, reach and source suppression', async () => {
    const s = await scope(false), id = await video(s), another = await video(s), store = local(), now = Date.now();
    store.db.prepare('UPDATE shorts_analytics_settings SET since=?').run(now - 100 * DAY);
    const plays = [], insert = store.db.prepare('INSERT INTO shorts_plays VALUES(?,?,?,?,?,?,?)');
    function add(short, viewer, started, seconds, source = 'for-you') {
      const p = { id: randomUUID(), short_id: short, viewer: createHash('sha256').update(viewer).digest('hex'), started, seconds, source, duration: 10 };
      insert.run(p.id, p.short_id, p.viewer, p.started, p.seconds, p.source, p.duration); plays.push(p);
    }
    for (let i = 0; i < 5; i++) add(id, `viewer-${i}`, now - DAY, 10);
    add(another, 'viewer-0', now - DAY, 5, 'saved'); add(id, 'viewer-0', now - 2 * DAY, 1, 'recent');
    add(id, 'before', now - 8 * DAY, 3); add(id, 'expired', now - 91 * DAY, 10);
    store.db.prepare('INSERT INTO shorts_view_totals VALUES(?,?)').run(id, 7);
    store.db.prepare('INSERT INTO shorts_view_totals VALUES(?,?)').run(another, 1);
    await a.initialize(s, hash, legacyAnalytics(store), true);
    const report = await b.report(s, [id, another], 7);
    assert.deepEqual(report.summary, playbackSummary(plays.filter(p => p.started >= report.start)));
    assert.deepEqual(report.previous, playbackSummary(plays.filter(p => p.started < report.start && p.started >= report.start - 7 * DAY)));
    assert.equal(report.summary.reach, 5); assert.equal(report.series.length, 7); assert.equal(report.start % DAY, 0);
    assert.equal(report.sources.find(s => s.source === 'for-you').views, 5); assert.equal(report.sources.find(s => s.source === 'saved').views, null);
    assert.deepEqual(await a.creatorReport(s, 'ak_creator', 7), report, 'owner report preserves all period, privacy and retention calculations');
    assert.equal(report.partial, false); assert.equal((await b.report(s, [id], 90)).previousPartial, true);
    assert.equal((await b.report(s, [], 7)).summary.views, 0);
    assert.equal((await a.counters(s, id)).engagement.score, 0.6);
    await assert.rejects(b.report(s, [id], 1000), { status: 400 });
  });
  await t.test('creator totals cover more than 100 videos without exposing another library or unbounded detail', async () => {
    const s = await scope(), now = Date.now(), started = now - DAY, viewer = 'f'.repeat(64);
    // Oversized fixture bypasses normal admission deliberately; the runtime cap stays 50.
    await one.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body)
      SELECT $1,$2,'catalog-'||i,CASE WHEN i<=121 THEN 'ak_creator' ELSE 'ak_other' END,i,
        jsonb_build_object('id','catalog-'||i,'creator',CASE WHEN i<=121 THEN 'ak_creator' ELSE 'ak_other' END,
          'createdAt',i,'duration',10) FROM generate_series(1,130) i`, params(s));
    await one.query(`INSERT INTO shorts_measurement_viewers VALUES($1,$2,$3,$4,0)`, [...params(s), viewer, now]);
    await one.query(`INSERT INTO shorts_measurement_plays SELECT $1,$2,'catalog-event-'||lpad(i::text,20,'0'),
      'catalog-'||i,$3,$4,$5,5,10,'for-you' FROM generate_series(1,130) i`,
      [...params(s), viewer, started, Math.floor(started / DAY)]);
    const report = await b.creatorReport(s, 'ak_creator', 7);
    assert.deepEqual(report.videoBreakdown, { total: 121, returned: 100, complete: false });
    assert.equal(report.summary.views, 121); assert.equal(report.summary.reach, 1);
    assert.equal(report.summary.watchSeconds, 605); assert.equal(report.series.reduce((n, d) => n + d.views, 0), 121);
    assert.equal(Object.keys(report.videos).length, 100);
    assert.equal(Object.values(report.videos).reduce((n, v) => n + v.views, 0), 100, 'breakdown is not the account total');
    assert.ok(report.videos['catalog-121']); assert.ok(!report.videos['catalog-1']);
    assert.equal(report.sources.find(r => r.source === 'for-you').suppressed, true);
    assert.equal((await a.creatorReport(s, 'ak_other', 7)).summary.views, 9);
    assert.equal((await a.creatorReport(s, 'ak_empty', 7)).videoBreakdown.total, 0);
    const selected = await a.creatorReport(s, 'ak_creator', 7, 'catalog-1');
    assert.deepEqual(selected.videoBreakdown, { total: 1, returned: 1, complete: true });
    assert.deepEqual(Object.keys(selected.videos), ['catalog-1']); assert.equal(selected.summary.views, 1);
    await assert.rejects(a.creatorReport(s, 'ak_other', 7, 'catalog-1'), { status: 404 });
    await assert.rejects(a.creatorReport(s, 'ak_creator', 7, 'missing'), { status: 404 });
    await assert.rejects(a.creatorReport(s, 'ak_creator', 7, []), { status: 400 });
    await assert.rejects(a.creatorReport(s, "ak_creator' OR true--", 7), { status: 400 });
    await assert.rejects(a.report(s, Array.from({ length: 121 }, (_, i) => `catalog-${i + 1}`), 7), { status: 400 });
    const other = await scope(); await video(other, 'catalog-1');
    assert.equal((await a.creatorReport(other, 'ak_creator', 7)).summary.views, 0);
    await b.forget(s, randomUUID()); // unrelated deletion cannot change the creator's totals
    assert.equal((await b.creatorReport(s, 'ak_creator', 7)).summary.views, 121);
  });
  await t.test('creator reports keep one repeatable snapshot during concurrent privacy deletion', async () => {
    const s = await scope(), id = await video(s), e = event();
    await a.record(s, id, e); await elapsed(s, e.id); await a.record(s, id, { ...e, seconds: 4 });
    let removed = false;
    const snapshot = new ShortsMeasurementsService({ transaction: (isolation, work) => {
      assert.equal(isolation, 'REPEATABLE READ');
      return one.transaction(isolation, async db => {
        const query = db.query.bind(db);
        db.query = async (sql, values) => {
          const result = await query(sql, values);
          if (!removed && sql.startsWith('SELECT salt,since')) { removed = true; await b.forget(s, e.session); }
          return result;
        };
        return work(db);
      });
    } });
    assert.equal((await snapshot.creatorReport(s, 'ak_creator', 7)).summary.views, 1);
    assert.equal((await a.creatorReport(s, 'ak_creator', 7)).summary.views, 0);
  });
  await t.test('expired raw events disappear from reports before cleanup; lifetime totals survive pruning', async () => {
    const s = await scope(), id = await video(s), e = event(); await a.record(s, id, e); await elapsed(s, e.id);
    await a.record(s, id, { ...e, seconds: 5 }); await elapsed(s, e.id, 91 * DAY);
    assert.equal((await b.report(s, [id], 90)).summary.views, 0); assert.equal((await b.counters(s, id)).engagement.score, 0.5);
    assert.equal((await b.counters(s, id)).views, 1);
    await b.forget(s, e.session); assert.equal((await b.counters(s, id)).views, 1, 'expired anonymous lifetime totals are not browser-identifiable');
    const other = event(); await a.record(s, id, other); await elapsed(s, other.id, 91 * DAY);
    await one.query('UPDATE shorts_measurement_viewers SET touched=$3 WHERE network=$1 AND contract=$2 AND forgotten_until=0', [...params(s), Date.now() - 91 * DAY]);
    const result = await a.prune(s); assert.equal(result.plays, 1); assert.equal(result.viewers, 1);
    assert.equal((await raw(s, 'shorts_measurement_viewers')).length, 1, 'active deletion marker survives cleanup');
    assert.equal(await a.record(s, id, event(e.session)), false);
  });
  await t.test('hosted HTTP measurement on one API is deleted on another, without local writes', async t => {
    const { NestFactory } = require('@nestjs/core');
    const { UnauthorizedException } = require('@nestjs/common');
    const { ShortsController } = require('./shorts.controller');
    const { ShortsService } = require('./shorts.service');
    const { ShortsAuthService } = require('./shorts-auth.service');
    const { ShortsUploadsService } = require('./shorts-uploads.service');
    const { ShortsAuthGuard } = require('./shorts-auth.guard');
    const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
    const { ShortsPlaybackEvidenceService } = require('./shorts-playback-evidence.service');
    const { playbackProof } = require('./testing/playback-proof.cjs');
    const key = Buffer.from('d'.repeat(64), 'hex');
    const s = await scope(), id = await video(s), e = event(), bases = [];
    const verifier = new ShortsPlaybackEvidenceService({ release: { network: 'ae_uat', contract: s.contract  }, state: { contract: s.contract } }); verifier.key = key;
    e.proof = playbackProof(key, { id, cid: 'bafyfixture' }, e.session, s.contract);
    for (const measurements of [a, b]) {
      const db = new DatabaseSync(':memory:'); locals.push(db);
      const hosted = new ShortsHostedAnalyticsService(measurements, { shared: true, chain: { release: { network: 'ae_uat', contract: s.contract }, state: { contract: s.contract, sourceHash: hash } } }, { db }); services.push(hosted);
      await hosted.initialize();
      const core = new ShortsService({ address: value => value }, {}, hosted,
        { report: async () => ({ earned: '0', paidLikes: 0 }) }, {}, {}, {}, {},
        { shared: true, all: () => { throw new Error('Full library enumeration is forbidden'); } });
      core.ensurePlayable = () => meta.get(s, id).then(v => v.record);
      const app = await NestFactory.create({ module: class MeasurementHttpTest {}, controllers: [ShortsController], providers: [
        ShortsAuthGuard, ShortsUploadInterceptor,
        { provide: ShortsPlaybackEvidenceService, useValue: { validate: verifier.validate.bind(verifier) } },
        { provide: ShortsService, useValue: core },
        { provide: ShortsAuthService, useValue: { authenticate: async authorization => {
          if (authorization === 'Bearer fixture-creator') return 'ak_creator';
          if (authorization === 'Bearer fixture-other') return 'ak_other';
          throw new UnauthorizedException();
        } } }, { provide: ShortsUploadsService, useValue: {} },
      ] }, { logger: false });
      await app.listen(0, '127.0.0.1'); t.after(() => app.close()); bases.push(await app.getUrl());
      assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n, 0);
    }
    const post = (base, route, body) => fetch(`${base}/shorts${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(bases[0], `/${id}/playback`, { ...e, proof: undefined })).status, 401);
    assert.equal((await post(bases[1], `/${id}/playback`, { ...e, session: randomUUID() })).status, 401);
    let response = await post(bases[0], `/${id}/playback`, e); assert.equal(response.status, 201); assert.equal((await response.json()).views, 0);
    for (let i = 0; i < 12; i++) {
      const unqualified = event();
      unqualified.proof = playbackProof(key, { id, cid: 'bafyfixture' }, unqualified.session, s.contract, { admittedMs: i % 2 ? 1500 : 0 });
      response = await post(bases[i % 2], `/${id}/playback`, { ...unqualified, seconds: 60 });
      assert.equal(response.status, 201); assert.equal((await response.json()).views, 0);
    }
    assert.equal((await raw(s, 'shorts_measurement_viewers')).length, 0);
    assert.equal((await raw(s, 'shorts_measurement_plays')).length, 0);
    response = await post(bases[1], `/${id}/playback`, { ...e, seconds: 5 }); assert.equal((await response.json()).views, 1);
    response = await fetch(`${bases[0]}/shorts/performance?days=7&address=ak_other`, { headers: { authorization: 'Bearer fixture-creator' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).summary.views, 1);
    response = await fetch(`${bases[1]}/shorts/performance?days=7&short=${id}`, { headers: { authorization: 'Bearer fixture-other' } });
    assert.equal(response.status, 404); await response.arrayBuffer();
    response = await fetch(`${bases[0]}/shorts/performance?days=7`); assert.equal(response.status, 401); await response.arrayBuffer();
    response = await post(bases[1], '/analytics/forget', { session: e.session }); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), { deleted: true });
    response = await post(bases[0], `/${id}/playback`, { ...e, seconds: 10 }); assert.deepEqual(await response.json(), { accepted: false, views: 0, engagement: { score: 0.5 } });
    response = await post(bases[0], '/analytics/forget', {}); assert.equal(response.status, 400); await response.arrayBuffer();
  });
  await t.test('missing shared storage fails closed and schema rollback preserves privacy history', async () => {
    const s = await scope();
    const broken = new ShortsMeasurementsService({ transaction: async () => { throw new Error('Database unavailable'); } });
    await assert.rejects(broken.forget(s, randomUUID()), /Database unavailable/);
    const before = await raw(s, 'shorts_measurement_settings');
    await assert.rejects(one.undoLastMigration({ transaction: 'all' }), /Restore\/reconcile/);
    assert.deepEqual(await raw(s, 'shorts_measurement_settings'), before);
  });
});

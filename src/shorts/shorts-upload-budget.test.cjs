const { releaseFixture } = require('./shorts-release.fixture.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { encode, Encoding } = require('@aeternity/aepp-sdk');
const { DataSource } = require('typeorm');
const { ShortsDatabaseService } = require('./shorts-database.service');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsUploadRecordsService } = require('./shorts-upload-records.service');
const { shortsUploadBudgetConfig } = require('./shorts-upload-budget');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
const { ShortsPublications1791763209000 } = require('../migrations/1791763209000-ShortsPublications');
const { ShortsPublisherAuthority1791763210000 } = require('../migrations/1791763210000-ShortsPublisherAuthority');
const { ShortsPublicationAdmission1791763223000 } = require('../migrations/1791763223000-ShortsPublicationAdmission');
const { ShortsPublicationBoundaryService } = require('./shorts-publication-boundary.service');
const hash = 'a'.repeat(64);
const input = (bytes = 10) => ({ bytes, title: 'Owned video', topic: 'Art', rights: true, sha256: hash, details: {} });
const jobInput = (bytes = 10) => ({ ...input(bytes), objectKey: `originals/${hash}` });
const record = (id, creator = 'ak_creator') => ({ id, creator, bytes: 100, createdAt: 1000,
  title: 'Owned video', topic: 'Art', cid: `bafy${id}`, moderation: 'pending', reports: 0, views: [], duration: 5,
  files: [{ name: 'video.mp4', bytes: 100, sha256: hash }] });

test('retained upload budgets are explicit setup inputs with strict integer bounds', () => {
  assert.equal(shortsUploadBudgetConfig({}), undefined);
  assert.deepEqual(shortsUploadBudgetConfig({ SHORTS_MAX_RETAINED_UPLOADS: '75', SHORTS_MAX_RETAINED_SOURCE_BYTES: '1000000' }),
    { uploads: 75, sourceBytes: 1000000 });
  for (const value of ['', '-1', '0', '1.5', '1e3', ' 50', 'NaN', 'Infinity', '1000001'])
    assert.throws(() => shortsUploadBudgetConfig({ SHORTS_MAX_RETAINED_UPLOADS: value, SHORTS_MAX_RETAINED_SOURCE_BYTES: '100' }));
  for (const value of [undefined, '', '0', '1000000000000001', '9007199254740993'])
    assert.throws(() => shortsUploadBudgetConfig({ SHORTS_MAX_RETAINED_UPLOADS: '50', SHORTS_MAX_RETAINED_SOURCE_BYTES: value }));
});

test('shared retained upload budgets survive competing requests, recovery, history and restrictive roles', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 60000,
}, async t => {
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = `shorts_budget_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const queries = [];
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 },
    logging: ['query'], logger: { logQuery: (sql, params) => queries.push({ sql, params }), logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} },
    migrations: [ShortsMetadata1791763200000, ShortsUploads1791763202000, ShortsPublications1791763209000, ShortsPublisherAuthority1791763210000, ShortsPublicationAdmission1791763223000] };
  const owner = new DataSource(options); await owner.initialize(); await owner.runMigrations({ transaction: 'all' });
  const adminMeta = new ShortsMetadataService(owner), guards = [], roles = [], connections = [];
  t.after(async () => {
    for (const db of connections) if (db.isInitialized) await db.destroy();
    for (const db of guards) if (db.isInitialized) await db.onModuleDestroy();
    await owner.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    for (const role of roles) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
    await admin.destroy();
  });
  const old = { network: 'ae_uat', contract: 'ct_existing' };
  await adminMeta.initialize(old, hash);
  await owner.query(`INSERT INTO shorts_upload_sessions(network,contract,id,creator,input,expires_at)
    SELECT $1,$2,'old-'||i,'ak_creator',$3::jsonb,now()-interval '1 day' FROM generate_series(1,61) i`,
    [old.network, old.contract, JSON.stringify(input())]);
  await adminMeta.enqueue(old, 'old-1', 'ak_creator', jobInput());
  await adminMeta.insertDraft(old, record('old-1'));
  await assert.rejects(adminMeta.verifyUploadBudget(old), { status: 503 });
  // Failed backfill must roll back its DDL and leave historical records intact.
  await owner.query("UPDATE shorts_content SET creator='ak_inconsistent',body=jsonb_set(body,'{creator}','\"ak_inconsistent\"') WHERE contract=$1", [old.contract]);
  await assert.rejects(owner.transaction(manager => new ShortsUploadBudget1791763224000().up(manager)), /inconsistent upload identities/);
  assert.equal((await owner.query("SELECT to_regclass('shorts_upload_budgets') AS relation"))[0].relation, null);
  await owner.query("UPDATE shorts_content SET creator='ak_creator',body=jsonb_set(body,'{creator}','\"ak_creator\"') WHERE contract=$1", [old.contract]);
  await owner.query("UPDATE shorts_ingestion SET input=jsonb_set(input,'{bytes}','11') WHERE contract=$1", [old.contract]);
  await assert.rejects(owner.transaction(manager => new ShortsUploadBudget1791763224000().up(manager)), /inconsistent upload identities/);
  await owner.query("UPDATE shorts_ingestion SET input=jsonb_set(input,'{bytes}','10') WHERE contract=$1", [old.contract]);
  await owner.query("UPDATE shorts_content SET body=jsonb_set(body,'{privateMedia}','{\"source\":{\"bytes\":11}}') WHERE contract=$1", [old.contract]);
  await assert.rejects(owner.transaction(manager => new ShortsUploadBudget1791763224000().up(manager)), /inconsistent upload identities/);
  await owner.query("UPDATE shorts_content SET body=body-'privateMedia' WHERE contract=$1", [old.contract]);
  await owner.transaction(manager => new ShortsUploadBudget1791763224000().up(manager));
  await adminMeta.verifyUploadBudget(old);
  assert.deepEqual(await adminMeta.uploadBudget(old), { maxUploads: '50', maxSourceBytes: '2097152000', usedUploads: '61', usedSourceBytes: '610', exhausted: true });

  async function guard() {
    const db = new ShortsDatabaseService(owner); await db.onModuleInit(); guards.push(db);
    const metadata = new ShortsMetadataService(db);
    return { db, metadata, uploads: new ShortsUploadRecordsService(db, metadata) };
  }
  const a = await guard(), b = await guard();
  async function scope(uploads = 50, sourceBytes = 2097152000) {
    const s = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` };
    await adminMeta.initialize(s, hash);
    await adminMeta.configureUploadBudget(s, { uploads, sourceBytes });
    await a.metadata.verifyUploadBudget(s); return s;
  }

  await t.test('backfilled identities charge once and do not discard uploads above the new default', async () => {
    await assert.rejects(a.uploads.create(old, 'extra', 'ak_other', input()), { status: 503 });
    assert.equal((await owner.query('SELECT count(*)::integer AS n FROM shorts_upload_sessions WHERE contract=$1', [old.contract]))[0].n, 61);
    await adminMeta.configureUploadBudget(old, { uploads: 100, sourceBytes: 1000 });
    await a.uploads.create(old, 'extra', 'ak_other', input());
    await b.metadata.initialize(old, hash);
    assert.deepEqual(await b.metadata.uploadBudget(old), { maxUploads: '100', maxSourceBytes: '1000', usedUploads: '62', usedSourceBytes: '620', exhausted: false });
  });

  await t.test('two API pools cannot overshoot the last byte reservation or charge duplicate requests', async () => {
    const s = await scope(3, 25);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      (i % 2 ? a : b).uploads.create(s, `race-${i}`, `ak_creator${i}`, input())));
    const accepted = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    assert.equal(accepted.length, 2);
    for (const result of results.filter(r => r.status === 'rejected')) {
      assert.equal(result.reason.status, 503); assert.match(result.reason.message, /storage capacity/);
    }
    const admitted = accepted[0];
    await Promise.all([a.uploads.create(s, admitted.id, admitted.creator, input()), b.uploads.create(s, admitted.id, admitted.creator, input())]);
    await assert.rejects(b.uploads.create(s, admitted.id, admitted.creator, input(11)), { status: 409 });
    assert.equal((await a.metadata.uploadBudget(s)).usedSourceBytes, '20');
    await b.db.onModuleDestroy(); const restarted = await guard();
    assert.equal((await restarted.metadata.uploadBudget(s)).usedUploads, '2');
    await restarted.uploads.create(s, 'last-five', 'ak_last', input(5));
    assert.equal((await restarted.metadata.uploadBudget(s)).usedSourceBytes, '25');
    assert.equal((await restarted.metadata.uploadBudget(s)).exhausted, true);
  });

  await t.test('failure, cancellation, expiry and lowering limits keep charges while retries can complete', async () => {
    const s = await scope(2, 100);
    await a.uploads.create(s, 'retry', 'ak_creator', input());
    await a.metadata.enqueue(s, 'retry', 'ak_creator', jobInput());
    const claim = await a.metadata.claim(s); await a.metadata.fail(s, claim);
    await a.uploads.create(s, 'cancelled', 'ak_other', input());
    await a.metadata.enqueue(s, 'cancelled', 'ak_other', jobInput()); await a.metadata.cancel(s, 'ak_other', 'cancelled');
    await owner.query("UPDATE shorts_upload_sessions SET expires_at=now()-interval '1 day' WHERE contract=$1", [s.contract]);
    await adminMeta.configureUploadBudget(s, { uploads: 1, sourceBytes: 1 });
    await assert.rejects(a.uploads.create(s, 'new', 'ak_new', input()), { status: 503 });
    await a.metadata.retry(s, 'ak_creator', 'retry');
    await a.metadata.complete(s, await a.metadata.claim(s), record('retry'));
    await a.metadata.change(s, 'retry', r => { r.publication = 'withdrawn'; });
    const budget = await a.metadata.uploadBudget(s);
    assert.equal(budget.usedUploads, '2'); assert.equal(budget.usedSourceBytes, '20'); assert.equal(budget.exhausted, true);
  });

  await t.test('a rolled-back acceptance rolls back its reservation and counters together', async () => {
    const s = await scope(1, 10);
    await assert.rejects(a.db.transaction(async manager => {
      await manager.query('INSERT INTO shorts_upload_sessions(network,contract,id,creator,input) VALUES($1,$2,$3,$4,$5::jsonb)',
        [s.network, s.contract, 'rollback', 'ak_creator', JSON.stringify(input())]);
      throw new Error('fixture interruption');
    }), /fixture interruption/);
    assert.equal((await a.metadata.uploadBudget(s)).usedUploads, '0');
    await a.uploads.create(s, 'retry', 'ak_creator', input());
    assert.equal((await a.metadata.uploadBudget(s)).usedUploads, '1');
  });

  await t.test('legacy package estimates bind a later source once, preserving charges and rejecting growth beyond budget', async () => {
    const s = await scope(3, 200);
    await a.metadata.insertDraft(s, record('small-source'));
    await a.uploads.create(s, 'small-source', 'ak_creator', input(10));
    assert.equal((await a.metadata.uploadBudget(s)).usedSourceBytes, '100', 'smaller source does not refund the legacy estimate');
    await a.metadata.insertDraft(s, record('large-source'));
    await assert.rejects(a.uploads.create(s, 'large-source', 'ak_creator', input(150)), { status: 503 });
    assert.equal((await a.metadata.uploadBudget(s)).usedSourceBytes, '200');
    await adminMeta.configureUploadBudget(s, { uploads: 3, sourceBytes: 250 });
    await a.uploads.create(s, 'large-source', 'ak_creator', input(150));
    await a.metadata.enqueue(s, 'large-source', 'ak_creator', jobInput(150));
    assert.equal((await a.metadata.uploadBudget(s)).usedSourceBytes, '250');
    assert.equal((await a.metadata.uploadBudget(s)).usedUploads, '2');
    await assert.rejects(owner.query('INSERT INTO shorts_ingestion(network,contract,id,creator,input) VALUES($1,$2,$3,$4,$5::jsonb)',
      [s.network, s.contract, 'small-source', 'ak_creator', JSON.stringify(jobInput(11))]), { code: 'SH409' });
    assert.equal((await a.metadata.uploadBudget(s)).usedSourceBytes, '250');
  });

  await t.test('an ignored duplicate content insert cannot bind or increase an existing reservation', async () => {
    const s = await scope(1, 200);
    await a.metadata.insertDraft(s, record('duplicate'));
    const ignored = { ...record('duplicate'), privateMedia: { source: { bytes: 150 } } };
    await owner.query(`INSERT INTO shorts_content(network,contract,id,creator,created_at,body)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
      [s.network, s.contract, ignored.id, ignored.creator, ignored.createdAt, JSON.stringify(ignored)]);
    assert.equal((await a.metadata.uploadBudget(s)).usedSourceBytes, '100');
    const [reservation] = await owner.query('SELECT declared_source_bytes FROM shorts_upload_reservations WHERE contract=$1', [s.contract]);
    assert.equal(reservation.declared_source_bytes, null);
    await a.uploads.create(s, 'duplicate', 'ak_creator', input(10));
    assert.equal((await a.metadata.uploadBudget(s)).usedSourceBytes, '100');
  });

  await t.test('a configured library can exceed 50 while preparation limits remain independent', async () => {
    const s = await scope(80, 1000);
    for (let i = 0; i < 75; i++) {
      const id = `video-${i}`, actor = `ak_creator${i}`;
      await a.uploads.create(s, id, actor, input());
      await a.metadata.enqueue(s, id, actor, jobInput());
      await a.metadata.complete(s, await a.metadata.claim(s), record(id, actor));
    }
    const budget = await a.metadata.uploadBudget(s);
    assert.equal(budget.usedUploads, '75'); assert.equal(budget.usedSourceBytes, '750');
    const first = await a.metadata.page(s, { limit: 20 });
    assert.equal(first.items.length, 20); assert.ok(first.next);
    await a.metadata.enqueue(s, 'queued-1', 'ak_pending', jobInput());
    await a.metadata.enqueue(s, 'queued-2', 'ak_pending', jobInput());
    await assert.rejects(a.metadata.enqueue(s, 'queued-3', 'ak_pending', jobInput()), { status: 503 });
    assert.equal((await a.metadata.uploadBudget(s)).usedUploads, '77', 'rejected preparation does not reserve new storage');
  });

  await t.test('runtime login cannot change budgets or erase charges; insert triggers need no counter grants', async () => {
    const s = await scope(1, 10), role = `budget_${randomUUID().replaceAll('-', '')}`; roles.push(role);
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'local-budget-fixture'`);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO "${role}";
      GRANT INSERT ON shorts_upload_sessions TO "${role}";
      GRANT SELECT ON shorts_upload_budgets TO "${role}"`);
    const roleUrl = new URL(url); roleUrl.username = role; roleUrl.password = 'local-budget-fixture';
    const db = new DataSource({ ...options, url: roleUrl.href, migrations: [] }); await db.initialize(); connections.push(db);
    await db.query('INSERT INTO shorts_upload_sessions(network,contract,id,creator,input) VALUES($1,$2,$3,$4,$5::jsonb)',
      [s.network, s.contract, 'restricted', 'ak_creator', JSON.stringify(input())]);
    assert.equal((await new ShortsMetadataService(db).uploadBudget(s)).usedUploads, '1');
    for (const sql of ['UPDATE shorts_upload_budgets SET max_uploads=999999', 'DELETE FROM shorts_upload_reservations', 'TRUNCATE shorts_upload_reservations'])
      await assert.rejects(db.query(sql), { code: '42501' });
    const [grants] = await db.query("SELECT has_function_privilege(current_user,'shorts_reserve_upload()','EXECUTE') AS direct");
    assert.equal(grants.direct, false);
    await owner.query('ALTER TABLE shorts_ingestion DISABLE TRIGGER shorts_reserve_upload');
    await assert.rejects(a.metadata.verifyUploadBudget(s), { status: 503 });
    await owner.query('ALTER TABLE shorts_ingestion ENABLE TRIGGER shorts_reserve_upload');
    await a.metadata.verifyUploadBudget(s);
  });

  await t.test('expiry admission uses a bounded indexed union instead of scanning the retained history', async () => {
    const s = await scope(20000, 1000000);
    await owner.query(`INSERT INTO shorts_upload_sessions(network,contract,id,creator,input,expires_at)
      SELECT $1,$2,'expired-'||i,'ak_creator',$3::jsonb,now()-interval '1 day' FROM generate_series(1,10000) i`,
      [s.network, s.contract, JSON.stringify(input())]);
    await owner.query(`INSERT INTO shorts_upload_admission(network,contract,upload_id,creator,bytes,created_at)
      SELECT network,contract,id,creator,10,now()-interval '2 hours' FROM shorts_upload_sessions WHERE contract=$1`, [s.contract]);
    await owner.query('ANALYZE shorts_upload_sessions; ANALYZE shorts_ingestion; ANALYZE shorts_upload_admission');
    queries.length = 0;
    await new ShortsUploadRecordsService(owner, adminMeta).create(s, 'live', 'ak_live', input());
    const lookup = queries.find(q => q.sql.includes(') active'));
    assert.ok(lookup); assert.match(lookup.sql, /UNION/);
    const [explain] = await owner.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${lookup.sql}`, lookup.params);
    const plan = explain['QUERY PLAN'][0].Plan;
    function walk(node) {
      if (node['Relation Name'] === 'shorts_upload_sessions') {
        assert.notEqual(node['Node Type'], 'Seq Scan');
        assert.ok(node['Actual Rows'] <= 100);
        assert.ok((node['Rows Removed by Filter'] || 0) <= 100);
      }
      for (const child of node.Plans || []) walk(child);
    }
    walk(plan);
    const window = queries.find(q => q.sql.includes('FROM shorts_upload_admission WHERE'));
    assert.ok(window);
    const [windowExplain] = await owner.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${window.sql}`, window.params);
    function checkWindow(node) {
      if (node['Relation Name'] === 'shorts_upload_admission') {
        assert.notEqual(node['Node Type'], 'Seq Scan');
        assert.ok(node['Actual Rows'] <= 100);
        assert.ok((node['Rows Removed by Filter'] || 0) <= 100);
      }
      for (const child of node.Plans || []) checkWindow(child);
    }
    checkWindow(windowExplain['QUERY PLAN'][0].Plan);
    assert.equal((await a.metadata.uploadBudget(s)).usedUploads, '10001');
  });

  await t.test('downgrade refuses to remove admitted reservations', async () => {
    const before = await a.metadata.uploadBudget(old);
    await assert.rejects(owner.transaction(manager => new ShortsUploadBudget1791763224000().down(manager)), /Preserve upload reservations/);
    assert.deepEqual(await a.metadata.uploadBudget(old), before);
  });

  await t.test('compiled Nest setup applies explicit limits, preserves omissions and grants API read-only capacity', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'shorts-budget-setup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const deployment = { network: 'ae_uat', contract: encode(Buffer.alloc(32, 7), Encoding.ContractAddress),
      operator: encode(Buffer.alloc(32, 8), Encoding.AccountAddress), sourceHash: hash };
    const scope = { network: deployment.network, contract: deployment.contract };
    const policy = { maxTransactionCost: '2000000000000000', rollingCostLimit: '10000000000000000',
      maxPending: 8, maxCreatorPending: 2, leaseMs: 120000, maxTtlBlocks: 30, confirmations: 3 };
    const manifest = join(directory, 'deployment.json'), policyFile = join(directory, 'policy.json'), envFile = join(directory, 'setup.env');
    await writeFile(manifest, JSON.stringify(releaseFixture(deployment).release)); await writeFile(policyFile, JSON.stringify(policy));
    const api = `budgetapi_${randomUUID().replaceAll('-', '')}`, signer = `budgetpub_${randomUUID().replaceAll('-', '')}`;
    for (const role of [api, signer]) { roles.push(role); await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'local-budget-fixture'`); }
    const env = { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_TESTNET_MVP: '1',
      DB_TYPE: 'postgres', DB_HOST: url.hostname, DB_PORT: url.port, DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
      DB_DATABASE: url.pathname.slice(1), DB_SYNC: 'false', DB_POOL_MAX: '2', DB_POOL_MIN: '1', PGOPTIONS: `-c search_path=${schema}`,
      SHORTS_DEPLOYMENT_FILE: manifest, SHORTS_PUBLISHING_POLICY_FILE: policyFile, SHORTS_PUBLISHER_API_ROLE: api, SHORTS_PUBLISHER_DB_ROLE: signer };
    async function run(limits = {}) {
      await writeFile(envFile, Object.entries({ ...env, ...limits }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 });
      return promisify(execFile)(process.execPath, [`--env-file=${envFile}`, 'dist/shorts/publisher-setup-main.js'],
        { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeout: 20000 });
    }
    const first = await run({ SHORTS_MAX_RETAINED_UPLOADS: '75', SHORTS_MAX_RETAINED_SOURCE_BYTES: '10000' });
    assert.match(first.stdout, /75 uploads \/ 10000 source bytes/);
    await run();
    assert.equal((await adminMeta.uploadBudget(scope)).maxUploads, '75');
    const roleUrl = new URL(url); roleUrl.username = api; roleUrl.password = 'local-budget-fixture';
    const apiDb = new DataSource({ ...options, url: roleUrl.href, migrations: [] }); await apiDb.initialize(); connections.push(apiDb);
    await new ShortsPublicationBoundaryService(apiDb).verify({ scope, sourceHash: hash, operator: deployment.operator, policy }, 'api');
    assert.equal((await new ShortsMetadataService(apiDb).uploadBudget(scope)).maxSourceBytes, '10000');
    await assert.rejects(new ShortsMetadataService(apiDb).configureUploadBudget(scope, { uploads: 99, sourceBytes: 10000 }), { code: '42501' });
    await run({ SHORTS_MAX_RETAINED_UPLOADS: '90', SHORTS_MAX_RETAINED_SOURCE_BYTES: '12000' });
    assert.equal((await adminMeta.uploadBudget(scope)).maxUploads, '90');
  });
});

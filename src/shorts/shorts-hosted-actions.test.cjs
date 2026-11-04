require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const Redis = require('ioredis');
const { NestFactory } = require('@nestjs/core');
const { DataSource } = require('typeorm');
const { AccountMemory } = require('@aeternity/aepp-sdk');
const { ShortsController } = require('./shorts.controller');
const { ShortsService } = require('./shorts.service');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsAuthGuard } = require('./shorts-auth.guard');
const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
const { ShortsUploadsService } = require('./shorts-uploads.service');
const { ShortsDatabaseService } = require('./shorts-database.service');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsRecordsService } = require('./shorts-records.service');
const { ShortsSessionsService } = require('./shorts-sessions.service');
const { ShortsRateService } = require('./shorts-rate.service');
const { shortsClientIdentity } = require('./shorts-rate.config');
const { ShortsWorkQueueService } = require('./shorts-work-queue.service');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsSessions1791763201000 } = require('../migrations/1791763201000-ShortsSessions');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsLifecycle1791763213000 } = require('../migrations/1791763213000-ShortsLifecycle');
const { ShortsSharedCutover1791763214000 } = require('../migrations/1791763214000-ShortsSharedCutover');
const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('hosted content actions stay responsive and durable across two HTTP runtimes during a slow scan', {
  skip: !process.env.SHORTS_TEST_PG_URL || !process.env.SHORTS_TEST_REDIS_URL,
  timeout: 45000,
}, async t => {
  const pg = new URL(process.env.SHORTS_TEST_PG_URL), redisUrl = new URL(process.env.SHORTS_TEST_REDIS_URL);
  assert.equal(pg.hostname, '127.0.0.1'); assert.equal(redisUrl.hostname, '127.0.0.1');
  const schema = `shorts_actions_${randomUUID().replaceAll('-', '')}`;
  const scope = { network: 'ae_uat', contract: `ct_${randomUUID().replaceAll('-', '')}` }, hash = 'a'.repeat(64);
  const saved = { AE_NETWORK_ID: process.env.AE_NETWORK_ID, SHORTS_WEB_ORIGIN: process.env.SHORTS_WEB_ORIGIN };
  process.env.AE_NETWORK_ID = 'ae_uat'; process.env.SHORTS_WEB_ORIGIN = 'http://127.0.0.1:5180';
  const admin = new DataSource({ type: 'postgres', url: pg.href }); await admin.initialize();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const owner = new DataSource({ type: 'postgres', url: pg.href, schema, synchronize: false,
    extra: { options: `-c search_path=${schema}`, max: 4 }, migrations: [ShortsMetadata1791763200000,
      ShortsSessions1791763201000, ShortsUploads1791763202000, ShortsLifecycle1791763213000,
      ShortsSharedCutover1791763214000, ShortsUploadBudget1791763224000] });
  const runtimes = [], entered = deferred(), finish = deferred(), redis = new Redis(redisUrl.href);
  let scanResult;
  t.after(async () => {
    finish.resolve(); await scanResult?.catch(() => {});
    for (const runtime of runtimes) await runtime.close();
    if (owner.isInitialized) await owner.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy();
    const prefix = `shorts:rate:v1:{${createHash('sha256').update('ae_uat:' + scope.contract).digest('hex').slice(0, 32)}}:`;
    const keys = await redis.keys(prefix + '*'); if (keys.length) await redis.del(...keys);
    redis.disconnect();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await owner.initialize(); await owner.runMigrations({ transaction: 'all' });
  const metadata = new ShortsMetadataService(owner); await metadata.initialize(scope, hash);
  const creator = AccountMemory.generate(), operator = AccountMemory.generate(), outsider = AccountMemory.generate();
  for (const id of ['scanned', 'live']) {
    await metadata.insertDraft(scope, {
    id, creator: creator.address, title: 'Owned clip', topic: 'Art', cid: `bafy${id}`, bytes: 100, createdAt: 1,
    duration: 5, files: [], moderation: 'pending', reports: 0, views: [],
    safety: { status: 'no_flags', checkedAt: 1 }, privateMedia: { version: 1 },
    });
    await metadata.change(scope, id, short => { short.moderation = 'approved'; short.publication = 'published'; });
  }
  const rateConfig = { key: randomBytes(32), client: shortsClientIdentity('127.0.0.1/32'),
    redis: { host: redisUrl.hostname, port: Number(redisUrl.port) } };
  async function runtime() {
    const db = new ShortsDatabaseService(owner); await db.onModuleInit();
    const queue = new ShortsWorkQueueService(), meta = new ShortsMetadataService(db);
    const chain = { release: { network: scope.network, contract: scope.contract }, state: { ...scope, sourceHash: hash, shorts: [] }, operator: { address: operator.address },
      address: value => value, serial: work => queue.run(work),
      read: async (_method, [id]) => { const { record } = await meta.get(scope, id);
        return { creator: record.creator, cid: record.cid, size: record.bytes, withdrawn: false }; } };
    const auth = new ShortsAuthService({ get db() { assert.fail('Hosted actions cannot use SQLite'); } }, chain, new ShortsSessionsService(db));
    const records = new ShortsRecordsService(chain, meta); await records.onModuleInit();
    const media = { safety: { demoAutoApprove: false }, rescan: async () => {
      entered.resolve(); await finish.promise; return { status: 'no_flags', checkedAt: Date.now() };
    } };
    const shorts = new ShortsService(chain, media, { counters: async () => ({ views: 0 }) }, {}, {}, auth, undefined, {}, records,
      { status: async () => undefined });
    const rates = new ShortsRateService(rateConfig, chain);
    const app = await NestFactory.create({ module: class HostedActions {}, controllers: [ShortsController], providers: [
      ShortsAuthGuard, ShortsUploadInterceptor, { provide: ShortsService, useValue: shorts },
      { provide: ShortsAuthService, useValue: auth }, { provide: ShortsUploadsService, useValue: {} },
      { provide: ShortsRateService, useValue: rates },
    ] }, { logger: false });
    let closed = false;
    const result = { app, records, async close() {
      if (closed) return; closed = true; await app.close(); await queue.onModuleDestroy(); await db.onModuleDestroy();
    } };
    runtimes.push(result); await app.listen(0, '127.0.0.1'); result.base = await app.getUrl(); return result;
  }
  const a = await runtime(), b = await runtime();
  async function post(api, path, body, token, ip = '192.0.2.10', timeout = 2500) {
    const response = await fetch(`${api.base}/shorts${path}`, { method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), retryAfter: response.headers.get('Retry-After') };
  }
  async function login(wallet) {
    const challenge = await post(a, '/auth/challenge', { address: wallet.address }); assert.equal(challenge.status, 201);
    const signature = Buffer.from(await wallet.signMessage(challenge.body.message)).toString('hex');
    const verified = await post(b, '/auth/verify', { id: challenge.body.id, signature }); assert.equal(verified.status, 201);
    return verified.body.token;
  }
  const creatorToken = await login(creator), operatorToken = await login(operator), outsiderToken = await login(outsider);

  await t.test('authentication and operator checks still run before any decision', async () => {
    assert.equal((await post(a, '/review/scanned', { approved: false })).status, 401);
    assert.equal((await post(b, '/review/scanned', { approved: false }, creatorToken)).status, 403);
    assert.equal((await b.records.get('scanned')).moderation, 'approved');
  });

  scanResult = post(a, '/scanned/scan', {}, creatorToken, '192.0.2.10', 30000);
  await Promise.race([entered.promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Scan did not start')), 3000); timer.unref();
    entered.promise.then(() => clearTimeout(timer));
  })]);
  await t.test('a stalled rescan does not delay denial, reports, appeals or compatibility view reads', async () => {
    assert.equal((await b.records.get('scanned')).moderation, 'pending');
    const denied = await post(a, '/review/scanned', { approved: false, reason: 'Restricted during inspection' }, operatorToken);
    assert.equal(denied.status, 201); assert.equal(denied.body.status, 'rejected');
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const reports = await Promise.all([a, b, a, b].map((api, i) => post(api, '/scanned/report',
      { id: ids[Math.max(0, i - 1)], reason: 'Safety' })));
    assert.ok(reports.every(r => r.status === 201));
    const current = await b.records.get('scanned'); assert.equal(current.reports, 3); assert.equal(current.reportDetails.length, 3);
    const appeals = await Promise.all([a, b].map(api => post(api, '/scanned/appeal', { message: 'Please check this decision.' }, creatorToken)));
    assert.deepEqual(appeals.map(r => r.status).sort(), [201, 409]);
    assert.equal((await post(a, '/live/view', { session: randomUUID() })).status, 201);
    assert.equal((await post(b, '/scanned/view', { session: randomUUID() })).status, 404);
    assert.equal((await post(b, '/scanned/appeal', { message: 'Please review this again.' }, outsiderToken)).status, 403);
  });

  finish.resolve();
  await t.test('late scan results cannot overwrite a newer moderation decision', async () => {
    assert.equal((await scanResult).status, 409);
    const short = await a.records.get('scanned');
    assert.equal(short.moderation, 'rejected'); assert.equal(short.safety, undefined);
    assert.equal(short.appeal.status, 'pending'); assert.equal(short.reviewHistory.length, 1);
  });

  await t.test('replicas still share report rate limits after bypassing the local queue', async () => {
    const requests = await Promise.all(Array.from({ length: 12 }, (_, i) => post(i % 2 ? a : b, '/scanned/report',
      { id: randomUUID(), reason: 'Spam' }, undefined, '192.0.2.99')));
    assert.equal(requests.filter(r => r.status === 201).length, 6);
    const denied = requests.filter(r => r.status === 429); assert.equal(denied.length, 6);
    assert.ok(denied.every(r => Number(r.retryAfter) >= 1));
    assert.equal((await b.records.get('scanned')).reports, 9);
  });

  await t.test('closing one API and reconnecting preserves reports, decisions, sessions and revocation', async () => {
    await a.close(); const c = await runtime();
    const short = await c.records.get('scanned');
    assert.equal(short.reports, 9); assert.equal(short.moderation, 'rejected'); assert.equal(short.appeal.status, 'pending');
    const invalid = await post(c, '/review/scanned', { approved: true }, operatorToken);
    assert.equal(invalid.status, 409, 'a prior approval cannot be restored without new evidence');
    assert.equal((await post(c, '/review/scanned', { approved: false, reason: 'Decision retained' }, operatorToken)).status, 201);
    assert.equal((await b.records.get('scanned')).appeal.status, 'resolved');
    assert.equal((await post(b, '/auth/logout', {}, operatorToken)).status, 200);
    assert.equal((await post(c, '/review/scanned', { approved: false }, operatorToken)).status, 401);
  });
});

test('local content operations still use the exclusive snapshot queue', async () => {
  const calls = [];
  const shorts = { records: { shared: false }, chain: { serial: async work => { calls.push('queue'); return work(); } },
    moderate: async () => calls.push('moderate'), appeal: async () => calls.push('appeal'),
    view: async () => calls.push('view'), report: async () => calls.push('report') };
  const controller = new ShortsController(shorts, { authenticate: async () => 'creator', operator: async () => 'operator' }, {});
  await controller.moderate('auth', 'id', { approved: false }); await controller.appeal('auth', 'id', { message: 'Appeal' });
  await controller.view('id', { session: 'session' }); await controller.report('id', { id: 'report', reason: 'Safety' });
  assert.deepEqual(calls, ['queue', 'moderate', 'queue', 'appeal', 'queue', 'view', 'queue', 'report']);
});

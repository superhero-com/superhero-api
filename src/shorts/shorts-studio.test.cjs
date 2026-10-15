const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { LocalShortsAnalyticsService: ShortsAnalyticsService, ANALYTICS_DAY } = require('./shorts-analytics.service');
const { ShortsLabelsService } = require('./shorts-labels.service');
const { LocalShortsLedgerService: ShortsLedgerService } = require('./local-ledger.service');
const { ShortsService } = require('./shorts.service');
const { randomUUID } = require('node:crypto');
const { ShortsAuthService } = require('./shorts-auth.service');

function studioAuth(t, enabled = true) {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.SHORTS_DEMO_CONNECTED_WALLET = enabled ? '1' : '0';
  process.env.SHORTS_TESTNET_MVP = '1';
  process.env.NODE_ENV = 'test';
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE challenges(id TEXT PRIMARY KEY, address TEXT, message TEXT, expires INTEGER);
    CREATE TABLE sessions(hash TEXT PRIMARY KEY, address TEXT, expires INTEGER);
    CREATE TABLE connected_wallet_sessions(hash TEXT PRIMARY KEY, address TEXT, expires INTEGER);`);
  const chain = { release: { network: 'ae_uat', contract: 'ct_test'  }, state: { contract: 'ct_test' }, operator: { address: 'ak_operator' }, address: a => {
    if (!a?.startsWith('ak_')) throw new Error('Invalid account');
    return a;
  } };
  return { db, chain, auth: new ShortsAuthService({ db }, chain) };
}

test('connection-only Studio sessions require explicit non-production local mode', async t => {
  const { db, chain, auth } = studioAuth(t, false);
  await assert.rejects(auth.connect('ak_creator'), /disabled/);
  process.env.SHORTS_DEMO_CONNECTED_WALLET = '1';
  process.env.SHORTS_TESTNET_MVP = '0';
  await assert.rejects(new ShortsAuthService({ db }, chain).connect('ak_creator'), /disabled/);
  process.env.SHORTS_TESTNET_MVP = '1';
  process.env.NODE_ENV = 'production';
  await assert.rejects(new ShortsAuthService({ db }, chain).connect('ak_creator'), /disabled/);
  process.env.NODE_ENV = 'test';
  await assert.rejects(new ShortsAuthService({ db }, chain).connect('invalid'), /Invalid AE address/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connected_wallet_sessions').get().n, 0);
});

test('connected Studio sessions stay account-scoped and never become operator or verified sessions', async t => {
  const { auth, db, chain } = studioAuth(t);
  const creator = await auth.connect('ak_creator'), other = await auth.connect('ak_other');
  assert.equal(creator.kind, 'connected-wallet');
  assert.equal(await auth.authenticate(`Bearer ${creator.token}`), 'ak_creator');
  assert.equal(await auth.authenticate(`Bearer ${other.token}`), 'ak_other');
  await assert.rejects(auth.authenticate(), /Sign in/);
  await assert.rejects(auth.authenticate(`Bearer ${'0'.repeat(64)}`), /Sign in/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(db.prepare('SELECT hash FROM connected_wallet_sessions WHERE address=?').get('ak_creator').hash.includes(creator.token), false);
  const operator = await auth.connect('ak_operator');
  await assert.rejects(auth.operator(`Bearer ${operator.token}`), /Sign in/);
  process.env.SHORTS_DEMO_CONNECTED_WALLET = '0';
  const normal = new ShortsAuthService({ db }, chain);
  await assert.rejects(normal.authenticate(`Bearer ${creator.token}`), /Sign in/);
  db.prepare('UPDATE connected_wallet_sessions SET expires=?').run(Date.now() - 1);
  await assert.rejects(auth.authenticate(`Bearer ${creator.token}`), /Sign in/);
});

test('signed operator access still verifies a real signature alongside connection-only Studio mode', async t => {
  const { AccountMemory } = require('@aeternity/aepp-sdk');
  const { auth, chain } = studioAuth(t);
  const operator = AccountMemory.generate();
  chain.operator.address = operator.address;
  const challenge = await auth.challenge(operator.address);
  const signature = Buffer.from(await operator.signMessage(challenge.message)).toString('hex');
  const session = await auth.verify(challenge.id, signature);
  assert.equal(session.kind, 'wallet-signature');
  assert.equal(await auth.operator(`Bearer ${session.token}`), operator.address);
  await assert.rejects(auth.verify(challenge.id, signature), /Invalid or expired/);
});

test('local demo tokens and signed challenges cannot cross contract or origin scopes', async t => {
  const { AccountMemory } = require('@aeternity/aepp-sdk');
  const { db, chain, auth } = studioAuth(t), wallet = AccountMemory.generate();
  const token = await auth.connect(wallet.address), challenge = await auth.challenge(wallet.address);
  const signature = Buffer.from(await wallet.signMessage(challenge.message)).toString('hex');
  const other = new ShortsAuthService({ db }, { ...chain, release: { network: 'ae_uat', contract: 'ct_other' }, state: { contract: 'ct_other' } });
  await assert.rejects(other.authenticate(`Bearer ${token.token}`), { status: 401 });
  await assert.rejects(other.verify(challenge.id, signature), { status: 401 });
  const signed = await auth.verify(challenge.id, signature);
  assert.equal(await auth.authenticate(`Bearer ${signed.token}`), wallet.address);
  assert.equal(await auth.authenticate(`Bearer ${token.token}`), wallet.address);
  const fresh = await auth.challenge(wallet.address);
  process.env.SHORTS_WEB_ORIGIN = 'https://another.example.com';
  await assert.rejects(auth.authenticate(`Bearer ${token.token}`), { status: 401 });
  await assert.rejects(auth.verify(fresh.id, Buffer.from(await wallet.signMessage(fresh.message)).toString('hex')), { status: 401 });
});

test('local logout revokes tokens and a connection-only session cannot revoke signed authority', async t => {
  const { AccountMemory } = require('@aeternity/aepp-sdk');
  const { auth } = studioAuth(t), wallet = AccountMemory.generate();
  const challenge = await auth.challenge(wallet.address);
  const signature = Buffer.from(await wallet.signMessage(challenge.message)).toString('hex');
  const signed = await auth.verify(challenge.id, signature), connected = await auth.connect(wallet.address);
  await assert.rejects(auth.logoutAll(`Bearer ${connected.token}`), { status: 401 });
  assert.equal(await auth.authenticate(`Bearer ${signed.token}`), wallet.address);
  const pending = await auth.challenge(wallet.address);
  await auth.logoutAll(`Bearer ${signed.token}`);
  await assert.rejects(auth.authenticate(`Bearer ${signed.token}`), { status: 401 });
  await assert.rejects(auth.authenticate(`Bearer ${connected.token}`), { status: 401 });
  await assert.rejects(auth.verify(pending.id, Buffer.from(await wallet.signMessage(pending.message)).toString('hex')), { status: 401 });
  const last = await auth.connect(wallet.address);
  await auth.logout(`Bearer ${last.token}`); await auth.logout(`Bearer ${last.token}`);
  await assert.rejects(auth.authenticate(`Bearer ${last.token}`), { status: 401 });
});

function analytics(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  return new ShortsAnalyticsService({ db });
}
test('playback requires elapsed time, caps loops and deduplicates a browser across Shorts', t => {
  let now = Date.UTC(2026, 8, 30, 12); t.mock.method(Date, 'now', () => now);
  const a = analytics(t), session = randomUUID(), first = randomUUID(), second = randomUUID();
  a.record({ id: 'a', duration: 10 }, { id: first, session, seconds: 0, source: 'for-you' });
  now += 1000;
  a.record({ id: 'a', duration: 10 }, { id: first, session, seconds: 60, source: 'for-you' });
  assert.equal(a.report(['a'], 7).summary.views, 0, 'a seek/jump cannot instantly count as playback');
  now += 9000;
  a.record({ id: 'a', duration: 10 }, { id: first, session, seconds: 60, source: 'for-you' });
  assert.equal(a.report(['a'], 7).summary.watchSeconds, 10);
  assert.equal(a.record({ id: 'a', duration: 10 }, { id: randomUUID(), session, seconds: 10, source: 'for-you' }).accepted, false);
  a.record({ id: 'b', duration: 5 }, { id: second, session, seconds: 0, source: 'saved' });
  now += 5000;
  a.record({ id: 'b', duration: 5 }, { id: second, session, seconds: 5, source: 'saved' });
  const p = a.report(['a', 'b'], 7);
  assert.equal(p.summary.views, 2); assert.equal(p.summary.reach, 1);
  assert.equal(p.summary.watchSeconds, 15); assert.equal(p.summary.completion, 1);
  assert.equal(p.partial, true); assert.ok(p.sources.every(s => s.suppressed));
  a.forget(session); assert.equal(a.report(['a', 'b'], 7).summary.views, 0);
});
test('UTC windows, prior periods, invalid events and expired retention', t => {
  let now = Date.UTC(2026, 8, 1); t.mock.method(Date, 'now', () => now);
  const a = analytics(t), session = randomUUID(), id = randomUUID();
  assert.throws(() => a.record({ id: 'a', duration: 10 }, { id, session, seconds: Infinity, source: 'for-you' }));
  a.record({ id: 'a', duration: 10 }, { id, session, seconds: 0, source: 'for-you' });
  now += 5000; a.record({ id: 'a', duration: 10 }, { id, session, seconds: 5, source: 'for-you' });
  now += 7 * ANALYTICS_DAY;
  const p = a.report(['a'], 7); assert.equal(p.summary.views, 0); assert.equal(p.previous.views, 1);
  assert.equal(p.start % ANALYTICS_DAY, 0); assert.equal(p.series.length, 7);
  assert.equal(a.report(['someone-else'], 7).previous.views, 0);
  now += 90 * ANALYTICS_DAY;
  a.record({ id: 'a', duration: 10 }, { id: randomUUID(), session, seconds: 0, source: 'for-you' });
  assert.equal(a.report(['a'], 90).summary.views, 0);
});
test('classification stays offline until enabled and never interprets a suggestion as approval', async t => {
  const saved = { ...process.env }; t.after(() => { process.env = saved; });
  delete process.env.SHORTS_JEV_ENABLED; delete process.env.TYPESAFE_API_KEY;
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected external request'); });
  const l = new ShortsLabelsService();
  const disabled = await l.classify({ title: 'Art', topic: 'Art' });
  assert.equal(disabled.status, 'manual'); assert.equal(fetch.mock.callCount(), 0);
  process.env.SHORTS_JEV_ENABLED = '1'; process.env.TYPESAFE_API_KEY = 'test-only'; process.env.SHORTS_JEV_MODEL = 'jev-1.13.0';
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { topic: { type: 'choice', choice: 'Nature', confidence: .92 } } })));
  const suggested = await l.classify({ title: 'Forest', topic: 'Art' });
  assert.equal(suggested.status, 'suggested'); assert.equal(suggested.topic, 'Nature'); assert.equal(suggested.approved, undefined);
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ model: 'jev-latest', answers: { topic: { type: 'choice', choice: 'Nature', confidence: .99 } } })));
  assert.equal((await l.classify({ title: 'Forest', topic: 'Art' })).status, 'review-needed');
  fetch.mock.mockImplementation(async () => { throw new Error('offline'); });
  assert.equal((await l.classify({ title: 'Forest', topic: 'Art' })).status, 'review-needed');
});
test('creator access, report idempotency, appeal ownership and moderation gates', async () => {
  const short = { id: 'a', creator: 'creator', moderation: 'rejected', reports: 0, safety: { status: 'no_flags', evidenceHash: 'reviewed-content' } };
  const service = new ShortsService({ address: a => a, state: { shorts: [short] }, operator: { address:'operator' }, save: async () => {} }, {}, {}, {}, {});
  await assert.rejects(service.appeal('other', 'a', 'Please review again'), /Only the creator/);
  await service.appeal('creator', 'a', 'Please review again');
  await assert.rejects(service.appeal('creator', 'a', 'Please review again'), /already/);
  await service.moderate('a', true, 'Rights verified'); assert.equal(short.appeal.status, 'resolved');
  const report = { id: randomUUID(), reason: 'Spam', detail: 'Local test report' };
  await service.report('a', report); await service.report('a', report); assert.equal(short.reports, 1);
  await assert.rejects(service.report('a', { ...report, reason: 'invalid' }), /Choose a reason/);
  await assert.rejects(service.performance('other', 7, 'a'), { status: 404 });
  await assert.rejects(service.performance('creator', 8), /Choose/);
});
test('ledger only counts confirmed creator earnings within the requested period', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const l = new ShortsLedgerService({}, { db }); l.syncedAt = Date.now();
  l.entries = [
    { id: '1', action: 'PaidLike', beneficiary: 'creator', at: 100, amount: '80000000000000000', confirmations: 3 },
    { id: '2', action: 'PaidLike', beneficiary: 'creator', at: 101, amount: '80000000000000000', confirmations: 1 },
    { id: '3', action: 'Claimed', beneficiary: 'creator', at: 102, amount: '80000000000000000', confirmations: 3 },
    { id: '4', action: 'PaidLike', beneficiary: 'other', at: 100, amount: '80000000000000000', confirmations: 3 },
  ];
  const p = l.report('creator', 100, 102); assert.equal(p.earned, '0.08'); assert.equal(p.paidLikes, 1); assert.equal(p.pending, 1);
  assert.equal(p.entries.length, 3); assert.equal(l.report('creator', 103, 104).earned, '0');
});
test('ledger refresh is idempotent and discards orphaned history on a canonical rebuild', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let canonical = true;
  const log = { call_tx_hash: 'th_test', block_hash: 'mh_test', block_time: 100 };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: canonical ? [log] : [], next: null })));
  const chain = { release: { network: 'ae_uat', contract: 'ct_test' }, state: { contract: 'ct_test', shorts: [{ id: 'a', creator: 'creator' }] }, sdk: { getHeight: async () => 10, api: {
    getTransactionByHash: async () => ({ tx: { callerId: 'viewer', contractId: 'ct_test' }, blockHash: 'mh_test', blockHeight: 5 }),
    getTransactionInfoByHash: async () => ({ callInfo: { returnType: 'ok', log: [] } }),
    getGenerationByHeight: async () => ({ microBlocks: ['mh_test'] }),
  } }, contract: { $options: { address: 'ct_test' }, $decodeEvents: () => [{ name: 'PaidLike', args: ['viewer', 80000000000000000n, 'a'] }] } };
  const l = new ShortsLedgerService(chain, { db });
  await l.sync(); await l.sync(); assert.equal(l.entries.length, 1); assert.equal(l.report('creator', 0, 200).earned, '0.08');
  canonical = false; await l.sync(); assert.equal(l.entries.length, 0);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); }); await l.sync(); assert.equal(l.report('creator', 0, 200).stale, true);
});
test('resumable uploads enforce ownership, exact parts, integrity and idempotent completion', async t => {
  const { ShortsUploadsService } = require('./shorts-uploads.service');
  const { createHash } = require('node:crypto');
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const parts = new Map(), videos = new Map(); let preparations = 0;
  const shorts = { chain: { state: { shorts: [] } }, media: {
    saveUploadPart: async (id, index, bytes) => parts.set(`${id}:${index}`, bytes),
    loadUploadPart: async (id, index) => parts.get(`${id}:${index}`),
    removeUploadParts: async (id, count) => { for (let i = 0; i < count; i++) parts.delete(`${id}:${i}`); },
  }, upload: async (actor, title, topic, bytes, details, id) => { preparations++; const video = { id, creator: actor, title, bytes:bytes.length }; videos.set(id, video); shorts.chain.state.shorts.push(video); return video; }, item: id => videos.get(id) };
  const { ShortsUploadLimitsService } = require('./shorts-upload-limits.service');
  const limits = new ShortsUploadLimitsService({ db });
  const u = new ShortsUploadsService({ db }, shorts, limits), bytes = Buffer.alloc(1024 * 1024 + 12, 'x');
  const input = { title:'Example', topic:'Art', rights:true, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'), details:{} };
  const session = await u.create('creator', input);
  await assert.rejects(u.get('other', session.id), /not found/);
  await assert.rejects(u.part('creator', session.id, 0, Buffer.from('bad')), /size or position/);
  await u.part('creator', session.id, 0, bytes.subarray(0, 1024 * 1024));
  const resumed = new ShortsUploadsService({ db }, shorts, limits);
  assert.deepEqual((await resumed.get('creator', session.id)).parts, [0]);
  await assert.rejects(resumed.finish('creator', session.id), /incomplete/);
  await resumed.part('creator', session.id, 1, bytes.subarray(1024 * 1024));
  const queued = await resumed.finish('creator', session.id);
  assert.equal(queued.status, 'queued');
  assert.equal(preparations, 0);
  await resumed.drain();
  const ready = await resumed.get('creator', session.id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.video.bytes, bytes.length); assert.equal(parts.size, 0);
  assert.deepEqual(await resumed.finish('creator', session.id), ready); assert.equal(preparations, 1);
  const corrupt = await u.create('creator', { ...input, bytes:12 });
  await u.part('creator', corrupt.id, 0, bytes.subarray(0,12));
  await u.finish('creator', corrupt.id); await u.drain();
  assert.equal((await u.get('creator', corrupt.id)).status, 'failed'); assert.equal(preparations, 1);
});


test('free publication verifies storage, persists intent and survives an ambiguous chain response', async () => {
  const short = { id: 'free', creator: 'creator', cid: 'cid', bytes: 1000, views: [], moderation: 'approved', safety: { status: 'no_flags' } };
  let video, writes = 0, pins = 0;
  const saved = [];
  const chain = { state: { shorts: [short] }, address: a => a,
    save: async () => saved.push(short.publication),
    read: async method => method === 'has_liked' ? false : video,
    write: async (method, args) => { assert.equal(method, 'publish'); assert.deepEqual(args, ['free', 'creator', 'cid', 1000]); writes++; video = { withdrawn: false, likes: 0, creator: 'creator', cid: 'cid', size: 1000n }; throw new Error('Node timeout after submission'); },
  };
  const service = new ShortsService(chain, { pin: async () => { pins++; } }, { counters: () => ({ views: 0, engagement: { score: 0.5 } }) }, {}, {});
  await assert.rejects(service.publish('other', 'free'), /Only the creator/);
  assert.equal(pins, 0); assert.equal(writes, 0);
  await assert.rejects(service.publish('creator', 'free'), /Node timeout/);
  assert.equal(short.publication, 'pending'); assert.deepEqual(saved, ['pending']);
  const result = await service.publish('creator', 'free');
  assert.equal(result.publicationStatus, 'published'); assert.equal(result.until, undefined);
  assert.equal(writes, 1); assert.equal(pins, 1);
  video.withdrawn = true;
  await assert.rejects(service.publish('creator', 'free'), /Withdrawn/);
});

test('storage outage never registers publication or debits a creator', async () => {
  const short = { id: 'free', creator: 'creator', cid: 'cid', bytes: 1000, views: [], moderation: 'approved', safety: { status: 'no_flags' } };
  const chain = { state: { shorts: [short] }, address: a => a, save: async () => {}, read: async () => undefined,
    write: async () => { throw new Error('Must not submit before storage verification'); } };
  const service = new ShortsService(chain, { pin: async () => { throw new Error('IPFS offline'); } }, {}, {}, {});
  await assert.rejects(service.publish('creator', 'free'), /IPFS offline/);
  assert.equal(short.publication, 'pending');
});

test('view totals migrate once, survive expiry and cannot be inflated by replay or the legacy endpoint', async t => {
  let now = Date.UTC(2026, 9, 5); t.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let a = new ShortsAnalyticsService({ db });
  const short = { id: 'a', creator: 'creator', cid: 'cid', bytes: 12, duration: 10, views: ['legacy'], moderation: 'approved', safety: { status: 'no_flags' } };
  const event = { id: randomUUID(), session: randomUUID(), seconds: 0, source: 'for-you' };
  a.record(short, event); now += 2500;
  assert.equal(a.record(short, { ...event, seconds: 2.5 }).views, 1);
  a.record(short, { ...event, seconds: 2.5 });
  a.record(short, { ...event, seconds: 0 });
  assert.equal(a.counters('a').views, 1);
  a = new ShortsAnalyticsService({ db });
  assert.equal(a.counters('a').views, 1, 'restart must not backfill twice');
  const service = new ShortsService({ state: { shorts: [short] }, read: async () => ({ withdrawn: false, creator: 'creator', cid: 'cid', size: 12n }) }, {}, a, {}, {}, {});
  assert.equal((await service.view('a', randomUUID())).views, 1);
  assert.deepEqual(short.views, ['legacy'], 'legacy endpoint is read only');
  now += 91 * ANALYTICS_DAY;
  assert.equal(a.counters('a').views, 1);
  assert.equal(a.report(['a'], 90).summary.views, 0);
  assert.equal(a.counters('a').engagement.score, 0.5);
});

test('deletion reverses retained counts and rejects in-flight requests, while a new browser session can measure', t => {
  let now = Date.UTC(2026, 9, 5); t.mock.method(Date, 'now', () => now);
  const a = analytics(t), short = { id: 'a', duration: 10 };
  const event = { id: randomUUID(), session: randomUUID(), seconds: 0, source: 'for-you' };
  a.record(short, event); now += 3000; a.record(short, { ...event, seconds: 3 });
  a.forget(event.session);
  assert.equal(a.counters('a').views, 0);
  assert.equal(a.record(short, { ...event, seconds: 3 }).accepted, false);
  assert.equal(a.record(short, { ...event, id: randomUUID() }).accepted, false);
  assert.equal(a.report(['a'], 7).summary.views, 0);
  assert.equal(a.record(short, { ...event, id: randomUUID(), session: randomUUID() }).accepted, true);
});

test('engagement uses recent browser-balanced watch quality, neutral cold starts and no payment data', t => {
  let now = Date.UTC(2026, 9, 5); t.mock.method(Date, 'now', () => now);
  const a = analytics(t);
  const shorts = [{ id: 'complete', duration: 10 }, { id: 'skipped', duration: 10 }];
  for (let n = 0; n < 5; n++) {
    const session = randomUUID(), events = shorts.map(() => randomUUID());
    shorts.forEach((short, i) => a.record(short, { id: events[i], session, seconds: 0, source: 'for-you' }));
    now += 10000;
    shorts.forEach((short, i) => a.record(short, { id: events[i], session, seconds: i ? 2 : 10, source: 'for-you' }));
    if (n < 4) assert.equal(a.engagement('complete').score, 0.5);
  }
  assert.ok(a.engagement('complete').score > 0.5);
  assert.ok(a.engagement('skipped').score < 0.5);
  assert.equal(a.counters('complete').views, 5);
  now += 8 * ANALYTICS_DAY;
  assert.equal(a.engagement('complete').score, 0.5);
});

test('UTC rollover closes old events and qualifies a new daily event once', t => {
  let now = Date.UTC(2026, 9, 5, 23, 59, 55); t.mock.method(Date, 'now', () => now);
  const a = analytics(t), short = { id: 'a', duration: 10 };
  const event = { id: randomUUID(), session: randomUUID(), seconds: 0, source: 'recent' };
  a.record(short, event); now += 3000; a.record(short, { ...event, seconds: 3 });
  now += 3000;
  assert.equal(a.record(short, { ...event, seconds: 6 }).accepted, false);
  const next = { ...event, id: randomUUID() };
  a.record(short, next); now += 3000;
  assert.equal(a.record(short, { ...next, seconds: 3 }).views, 2);
});

test('watch hours preserve qualified seconds across daily, video and previous-period reports', t => {
  let now = Date.UTC(2026, 9, 5, 12); t.mock.method(Date, 'now', () => now);
  const a = analytics(t), sessions = [];
  for (let i = 0; i < 60; i++) {
    const short = { id: i % 2 ? 'a' : 'b', duration: 60 };
    const event = { id: randomUUID(), session: randomUUID(), seconds: 0, source: 'for-you' };
    sessions.push(event.session);
    a.record(short, event); now += 60000;
    a.record(short, { ...event, seconds: 60 });
    a.record(short, { ...event, seconds: 60 });
  }
  const brief = { id: randomUUID(), session: randomUUID(), seconds: 0, source: 'recent' };
  a.record({ id: 'a', duration: 60 }, brief); now += 1500;
  a.record({ id: 'a', duration: 60 }, { ...brief, seconds: 1.5 });
  const report = a.report(['a', 'b'], 7);
  assert.equal(report.summary.views, 60, 'short playback and retries must not add views');
  assert.equal(report.summary.watchSeconds, 3600);
  assert.equal(report.summary.watchHours, 1);
  assert.equal(report.summary.averageSeconds, 60);
  assert.equal(report.series.reduce((sum, day) => sum + day.watchHours, 0), 1);
  assert.equal(report.videos.a.watchHours, 0.5);
  assert.equal(report.videos.b.watchHours, 0.5);
  assert.equal(report.previous.watchHours, 0);
  a.forget(sessions[0]);
  assert.equal(a.report(['a', 'b'], 7).summary.watchHours, 3540 / 3600, 'fractional hours are not rounded in the API');
  now += 7 * ANALYTICS_DAY;
  assert.equal(a.report(['a', 'b'], 7).previous.watchHours, 3540 / 3600);
  assert.equal(a.report(['a', 'b'], 7).summary.watchHours, 0);
});


test('hosted creator analytics never enumerates the library and drains admission after errors', async () => {
  let resolve, fail = false;
  const calls = [], gate = new Promise(r => { resolve = r; });
  const chain = { address: value => value }, records = { shared: true, all: () => { throw new Error('Full library read'); } };
  const analytics = { creatorReport: async (...args) => {
    calls.push(args); await gate; if (fail) throw new Error('Measurements unavailable');
    return { start: 1000, end: 2000, summary: { views: 121 }, videoBreakdown: { total: 121, returned: 100, complete: false } };
  } };
  const financial = [], ledger = { report: async (...args) => { financial.push(args); return { earned: '1', paidLikes: 10 }; } };
  const service = new ShortsService(chain, {}, analytics, ledger, {}, {}, {}, {}, records);
  const pending = Array.from({ length: 4 }, () => service.performance('ak_creator', 7));
  await assert.rejects(service.performance('ak_creator', 7), { status: 503 });
  assert.equal(calls.length, 4); resolve();
  for (const result of await Promise.all(pending)) assert.equal(result.summary.views, 121);
  await service.performance('ak_creator', 28, 'chosen'); assert.deepEqual(calls.at(-1), ['ak_creator', 28, 'chosen']);
  assert.ok(financial.every(args => args[0] === 'ak_creator'));
  fail = true; await assert.rejects(service.performance('ak_creator', 7), /Measurements unavailable/);
  fail = false; await service.performance('ak_creator', 7);
  const missing = new ShortsService(chain, {}, {}, ledger, {}, {}, {}, {}, records);
  await assert.rejects(missing.performance('ak_creator', 7), { status: 503 });
});

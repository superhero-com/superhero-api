const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ShortsAnalyticsService, ANALYTICS_DAY } = require('./shorts-analytics.service');
const { ShortsLabelsService } = require('./shorts-labels.service');
const { ShortsLedgerService } = require('./shorts-ledger.service');
const { ShortsService } = require('./shorts.service');
const { randomUUID } = require('node:crypto');

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
  const service = new ShortsService({ state: { shorts: [short] }, operator: { address:'operator' }, save: async () => {} }, {}, {}, {}, {});
  await assert.rejects(service.appeal('other', 'a', 'Please review again'), /Only the creator/);
  await service.appeal('creator', 'a', 'Please review again');
  await assert.rejects(service.appeal('creator', 'a', 'Please review again'), /already/);
  await service.moderate('a', true, 'Rights verified'); assert.equal(short.appeal.status, 'resolved');
  const report = { id: randomUUID(), reason: 'Spam', detail: 'Local test report' };
  await service.report('a', report); await service.report('a', report); assert.equal(short.reports, 1);
  await assert.rejects(service.report('a', { ...report, reason: 'invalid' }), /Choose a reason/);
  await assert.rejects(service.performance('other', 7, 'a'), /Creator access/);
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
  const chain = { state: { contract: 'ct_test', shorts: [{ id: 'a', creator: 'creator' }] }, sdk: { getHeight: async () => 10, api: {
    getTransactionByHash: async () => ({ tx: { callerId: 'viewer', contractId: 'ct_test' }, blockHash: 'mh_test', blockHeight: 5 }),
    getTransactionInfoByHash: async () => ({ callInfo: { returnType: 'ok', log: [] } }),
    getGenerationByHeight: async () => ({ microBlocks: ['mh_test'] }),
  } }, contract: { $decodeEvents: () => [{ name: 'PaidLike', args: ['viewer', 80000000000000000n, 'a'] }] } };
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
  const shorts = { media: {
    saveUploadPart: async (id, index, bytes) => parts.set(`${id}:${index}`, bytes),
    loadUploadPart: async (id, index) => parts.get(`${id}:${index}`),
    removeUploadParts: async (id, count) => { for (let i = 0; i < count; i++) parts.delete(`${id}:${i}`); },
  }, upload: async (actor, title, topic, bytes, details, id) => { preparations++; const video = { id, actor, title, bytes:bytes.length }; videos.set(id, video); return video; }, item: id => videos.get(id) };
  const u = new ShortsUploadsService({ db }, shorts), bytes = Buffer.alloc(1024 * 1024 + 12, 'x');
  const input = { title:'Example', topic:'Art', rights:true, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'), details:{} };
  const session = await u.create('creator', input);
  assert.throws(() => u.get('other', session.id), /not found/);
  await assert.rejects(u.part('creator', session.id, 0, Buffer.from('bad')), /size or position/);
  await u.part('creator', session.id, 0, bytes.subarray(0, 1024 * 1024));
  const resumed = new ShortsUploadsService({ db }, shorts);
  assert.deepEqual(resumed.get('creator', session.id).parts, [0]);
  await assert.rejects(resumed.finish('creator', session.id), /incomplete/);
  await resumed.part('creator', session.id, 1, bytes.subarray(1024 * 1024));
  const video = await resumed.finish('creator', session.id);
  assert.equal(video.bytes, bytes.length); assert.equal(parts.size, 0);
  assert.deepEqual(await resumed.finish('creator', session.id), video); assert.equal(preparations, 1);
  const corrupt = await u.create('creator', { ...input, bytes:12 });
  await u.part('creator', corrupt.id, 0, bytes.subarray(0,12));
  await assert.rejects(u.finish('creator', corrupt.id), /checksum/);
});

test('duration quotes preserve integer rounding and budget quotes remain compatible', async () => {
  const writes = [];
  const short = { id: 'duration', creator: 'creator', cid: 'cid', bytes: 100_000_001 };
  const chain = {
    state: { shorts: [short] }, address: value => value,
    read: async method => {
      if (method === 'get_config') return [0, 0, 0, 0, 10n ** 19n, 3_000_000_000n];
      if (method === 'get_short') return null;
      if (method === 'get_quote') {
        const days = BigInt(writes.at(-1)[1][4]);
        return { amount: (BigInt(short.bytes) * 10n ** 19n * days + 3_000_000_000n - 1n) / 3_000_000_000n, expected_until: 0, expires: Date.now() + 60000, rate_version: 1 };
      }
    },
    write: async (...args) => { writes.push(args); return { decodedResult: '1' }; },
  };
  const service = new ShortsService(chain, {}, {}, {}, {});
  assert.deepEqual(await service.hostingPrices('creator', 'duration'), {
    shortId: 'duration', bytes: short.bytes, numerator: '10000000000000000000', denominator: '3000000000', maxDays: 3650,
  });
  await assert.rejects(service.hostingPrices('other', 'duration'), /Only the creator/);
  const q = await service.quote('creator', 'duration', undefined, 'rewards', 30);
  assert.equal(q.days, 30); assert.equal(q.charge, '10.0000001'); assert.equal(q.unused, '0');
  assert.equal(writes[0][1][6], true);
  const budget = await service.quote('creator', 'duration', '10', 'wallet');
  assert.equal(budget.days, 29); assert.equal(budget.amountAettos, '9666666763333333334');
  const count = writes.length;
  for (const days of [0, -1, 1.5, 3651, '30', null]) {
    await assert.rejects(service.quote('creator', 'duration', undefined, 'wallet', days), /whole days/);
  }
  await assert.rejects(service.quote('creator', 'duration', '10', 'wallet', 30), /duration or an AE budget/);
  await assert.rejects(service.quote('creator', 'duration', undefined, 'wallet'), /duration or an AE budget/);
  await assert.rejects(service.quote('other', 'duration', undefined, 'wallet', 30), /Only the creator/);
  assert.equal(writes.length, count, 'invalid or unauthorized input never registers a quote');
});

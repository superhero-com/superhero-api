require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { NestFactory } = require('@nestjs/core');
const { HttpException, UnauthorizedException, ForbiddenException, NotFoundException, ServiceUnavailableException } = require('@nestjs/common');
const { ShortsMeasurementMonitorService, MEASUREMENT_OUTCOMES } = require('./shorts-measurement-monitor.service');

test('measurement telemetry bounds cardinality and history, isolates replicas and snapshots, and reports saturation', () => {
  const monitor = new ShortsMeasurementMonitorService();
  let elapsed = 0; monitor.elapsed = () => elapsed;
  const before = monitor.snapshot();
  for (let i = 0; i < 10000; i++) {
    monitor.record('invalid_evidence');
    monitor.record(randomUUID());
  }
  monitor.record('__proto__');
  assert.deepEqual(Object.keys(monitor.snapshot().cumulative), MEASUREMENT_OUTCOMES);
  assert.equal(monitor.snapshot().cumulative.invalid_evidence, 10000);
  const copy = monitor.snapshot(); copy.cumulative.invalid_evidence = -1; copy.recent[0].counts.invalid_evidence = -1;
  assert.equal(monitor.snapshot().recent[0].counts.invalid_evidence, 10000);
  for (let i = 1; i <= 13; i++) { elapsed = i * before.bucketMs; monitor.record('accepted_update'); }
  assert.equal(monitor.ring.length, 12);
  assert.equal(monitor.snapshot().recent.length, 12);
  assert.equal(monitor.snapshot().recent.reduce((n, v) => n + v.counts.invalid_evidence, 0), 0);
  assert.equal(monitor.snapshot().cumulative.invalid_evidence, 10000, 'lifetime counters survive window rotation');
  elapsed += before.windowMs;
  assert.deepEqual(monitor.snapshot().recent, [], 'idle windows expire without timers');
  monitor.cumulative.server_error = Number.MAX_SAFE_INTEGER;
  monitor.record('server_error');
  assert.equal(monitor.snapshot().cumulative.server_error, Number.MAX_SAFE_INTEGER);
  assert.equal(monitor.snapshot().saturated, true);
  const other = new ShortsMeasurementMonitorService().snapshot();
  assert.notEqual(other.instance, before.instance);
  assert.equal(other.cumulative.invalid_evidence, 0);
  assert.equal(other.scope, 'process');
});

test('operator-only HTTP telemetry classifies real proof/controller and guard outcomes without identities or double counts', async t => {
  const { ShortsController } = require('./shorts.controller');
  const { ShortsService } = require('./shorts.service');
  const { ShortsAuthService } = require('./shorts-auth.service');
  const { ShortsUploadsService } = require('./shorts-uploads.service');
  const { ShortsRateService } = require('./shorts-rate.service');
  const { ShortsAuthGuard } = require('./shorts-auth.guard');
  const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
  const { ShortsPlaybackEvidenceService } = require('./shorts-playback-evidence.service');
  const { LocalShortsAnalyticsService } = require('./shorts-analytics.service');
  const { playbackProof } = require('./testing/playback-proof.cjs');
  const key = Buffer.from('f'.repeat(64), 'hex'), contract = 'ct_monitorfixture', id = randomUUID();
  const short = { id, cid: 'bafyfixture', duration: 10 };
  const evidence = new ShortsPlaybackEvidenceService({ release: { network: 'ae_uat', contract }, state: { contract } }); evidence.key = key;
  const db = new DatabaseSync(':memory:'); const analytics = new LocalShortsAnalyticsService({ db });
  const monitor = new ShortsMeasurementMonitorService();
  let limited = false, unavailable = false, broken = false;
  const core = { analytics: {
    counters: analytics.counters.bind(analytics),
    record: (...args) => { if (broken) throw new Error('Fixture failure'); return analytics.record(...args); },
  }, ensurePlayable: async value => {
    if (unavailable) throw new ServiceUnavailableException();
    if (value !== id) throw new NotFoundException();
    return short;
  } };
  const auth = {
    shared: true,
    authenticate: async token => { if (!['Bearer operator', 'Bearer creator'].includes(token)) throw new UnauthorizedException(); return token; },
    operator: async token => { await auth.authenticate(token); if (token !== 'Bearer operator') throw new ForbiddenException(); },
  };
  const rates = { config: { client: () => '127.0.0.1' }, request: async policy => {
    if (limited && policy.group === 'measurement') throw new HttpException({ retryAfter: 1 }, 429);
  }, actor: async () => {} };
  const app = await NestFactory.create({ module: class MeasurementMonitorHttp {}, controllers: [ShortsController], providers: [
    ShortsAuthGuard, ShortsUploadInterceptor,
    { provide: ShortsService, useValue: core }, { provide: ShortsAuthService, useValue: auth },
    { provide: ShortsUploadsService, useValue: {} }, { provide: ShortsRateService, useValue: rates },
    { provide: ShortsPlaybackEvidenceService, useValue: evidence }, { provide: ShortsMeasurementMonitorService, useValue: monitor },
  ] }, { logger: false });
  t.after(async () => { await app.close(); db.close(); });
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const status = async token => {
    const response = await fetch(base + '/shorts/operator/measurements', { headers: token ? { authorization: token } : {} });
    const body = await response.json(); return { response, body };
  };
  assert.equal((await status()).response.status, 401);
  assert.equal((await status('Bearer creator')).response.status, 403);
  const event = { id: randomUUID(), session: randomUUID(), seconds: 3, source: 'shared' };
  const proof = playbackProof(key, short, event.session, contract);
  const post = async (body, shortId = id) => {
    const response = await fetch(base + `/shorts/${shortId}/playback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); return { status: response.status, result, headers: response.headers };
  };
  assert.equal((await post({ ...event, proof: playbackProof(key, short, event.session, contract, { admittedMs: 0 }) })).status, 201);
  assert.equal((await post({ ...event, proof })).result.views, 1);
  assert.equal((await post({ ...event, proof })).result.views, 1, 'accepted updates are not a view count');
  assert.equal((await post({ ...event, id: randomUUID(), proof })).result.accepted, false);
  assert.equal((await post({ ...event, proof, seconds: 99 })).status, 400);
  assert.equal((await post({ ...event, proof: 'forged' })).status, 401);
  assert.equal((await post({ ...event, proof }, randomUUID())).status, 404);
  unavailable = true; assert.equal((await post({ ...event, proof })).status, 503); unavailable = false;
  broken = true; assert.equal((await post({ ...event, proof })).status, 500); broken = false;
  limited = true; const denial = await post({ ...event, proof }); limited = false;
  assert.equal(denial.status, 429); assert.equal(denial.headers.get('retry-after'), '1');
  const { response, body } = await status('Bearer operator');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(body.cumulative, Object.fromEntries(MEASUREMENT_OUTCOMES.map(outcome => [outcome, outcome === 'accepted_update' ? 2 : 1])));
  for (const value of [event.id, event.session, proof, short.id, short.cid, contract, '127.0.0.1', 'Bearer operator'])
    assert.ok(!JSON.stringify(body).includes(value), 'telemetry contains no request identity, secret or content reference');
});

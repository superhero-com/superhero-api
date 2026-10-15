require('reflect-metadata');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Redis = require('ioredis');
const { NestFactory } = require('@nestjs/core');
const { UnauthorizedException } = require('@nestjs/common');
const { ShortsUploadAdmissionService, SHORTS_UPLOAD_ADMISSION_LIMITS } = require('./shorts-upload-admission.service');
const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
const { ShortsController } = require('./shorts.controller');
const { ShortsService } = require('./shorts.service');
const { ShortsUploadsService } = require('./shorts-uploads.service');
const { ShortsHostedUploadsService } = require('./shorts-hosted-uploads.service');
const { ShortsSourceService } = require('./shorts-source.service');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsAuthGuard } = require('./shorts-auth.guard');
const { ShortsChainService } = require('./shorts-chain.service');
const { ShortsRateService } = require('./shorts-rate.service');
const { SHORTS_RATE_CONFIG } = require('./shorts-rate.config');

let redisProcess, directory, port, control;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'shorts-upload-capacity-'));
  const socket = http.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  redisProcess = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory,
    '--save', '', '--appendonly', 'no', '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction']);
  await new Promise((resolve, reject) => {
    redisProcess.on('error', reject);
    redisProcess.stdout.on('data', chunk => { if (String(chunk).includes('Ready to accept connections')) resolve(); });
    redisProcess.on('exit', code => reject(new Error(`Fixture Redis exited ${code}`)));
  });
  control = new Redis({ host: '127.0.0.1', port }); await control.ping();
});
after(async () => {
  control?.disconnect();
  if (redisProcess && redisProcess.exitCode === null) { redisProcess.kill('SIGTERM'); await once(redisProcess, 'exit'); }
  if (directory) await rm(directory, { recursive: true, force: true });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  do { if (await check()) return; await sleep(20); } while (Date.now() < end);
  throw new Error('Condition did not become true');
}
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t, overrides = {}) {
  const env = { ...process.env }; process.env.AE_NETWORK_ID = 'ae_uat';
  const config = { key: randomBytes(32), redis: { host: '127.0.0.1', port }, client: () => 'v4:127.0.0.1' };
  const contract = `ct_${randomUUID().replaceAll('-', '')}`;
  const chain = { release: { network: 'ae_uat', contract }, state: { contract, sourceHash: 'a'.repeat(64) } };
  const limits = { capacity: 2, leaseMs: 2000, renewMs: 400, ...overrides };
  const services = [], apps = [], requests = [];
  t.after(async () => {
    for (const req of requests) req.destroy();
    for (const app of apps) await app.close();
    for (const service of services) await service.beforeApplicationShutdown();
    process.env = env;
  });
  async function service(settings = limits, key = config.key, scope = chain) {
    const instance = new ShortsUploadAdmissionService({ ...config, key }, scope, settings);
    services.push(instance); await instance.onApplicationBootstrap(); return instance;
  }
  async function api(uploads, options = {}) {
    process.env.SHORTS_UPLOAD_OPERATION_TIMEOUT_MS = String(options.timeout || 180000);
    const auth = { shared: true, authenticate: async value => {
      const actor = /^Bearer (ak_[a-zA-Z0-9]+)$/.exec(value || '')?.[1];
      if (!actor) throw new UnauthorizedException(); return actor;
    } };
    const app = await NestFactory.create({ module: class UploadCapacityHttp {}, controllers: [ShortsController], providers: [
      ShortsAuthGuard, ShortsUploadInterceptor, ShortsUploadAdmissionService,
      { provide: SHORTS_RATE_CONFIG, useValue: config }, { provide: SHORTS_UPLOAD_ADMISSION_LIMITS, useValue: limits },
      { provide: ShortsChainService, useValue: chain }, { provide: ShortsAuthService, useValue: auth },
      // Independent rate tests cover this guard; these requests exercise real
      // authentication ordering, controller/interceptor and shared capacity.
      { provide: ShortsRateService, useValue: { config, request: async () => {}, actor: async () => {} } },
      { provide: ShortsService, useValue: { chain: { ...chain, serial: fn => fn() } } },
      { provide: ShortsUploadsService, useValue: uploads },
    ] }, { logger: false });
    apps.push(app); await app.listen(0, '127.0.0.1');
    return { app, base: await app.getUrl(), admission: app.get(ShortsUploadAdmissionService) };
  }
  function slow(origin, actor, route = '/shorts/uploads/owned/parts/0') {
    const result = gate();
    const req = http.request(origin.base + route, { method: 'POST', headers: { Authorization: `Bearer ${actor}`,
      'Content-Type': 'multipart/form-data; boundary=owned', 'Content-Length': '1000' } }, res => {
      res.resume(); result.resolve(res.statusCode); req.destroy();
    });
    req.on('error', () => result.resolve('closed'));
    req.setTimeout(5000, () => { result.resolve('timeout'); req.destroy(); });
    req.write('--owned\r\nContent-Disposition: form-data; name="file"; filename="part"\r\n\r\npartial');
    requests.push(req); return { req, result: result.promise };
  }
  async function part(origin, actor, signal) {
    const body = new FormData(); body.append('file', new Blob(['owned bytes']), 'part');
    return fetch(origin.base + '/shorts/uploads/owned/parts/0', { method: 'POST', headers: { Authorization: `Bearer ${actor}` }, body, signal });
  }
  return { config, chain, limits, service, api, slow, part };
}

test('shared capacity is atomic across replicas and scope; wallet identities are not stored in keys', async t => {
  const f = await fixture(t, { capacity: 3 }); const a = await f.service(), b = await f.service();
  const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).acquire(`ak_creator${i}`)));
  const accepted = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  assert.equal(accepted.length, 3); assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 503));
  const held = [...a.leases, ...b.leases][0];
  assert.equal(await control.zcard(held.keys[0]), 3);
  assert.ok((await control.keys(held.keys[0].replace(/:active$/, ':*'))).every(k => !k.includes('ak_creator')));
  assert.ok(await control.pttl(held.keys[1]) > 0);
  const other = await f.service(f.limits, f.config.key, { release: { network: 'ae_uat', contract: f.chain.state.contract + 'Other' }, state: { ...f.chain.state, contract: f.chain.state.contract + 'Other' } });
  const independent = await other.acquire('ak_creator0'); await independent.release();
  await accepted[0].release(); const reused = await b.acquire('ak_reused'); await reused.release();
  await Promise.all(accepted.map(r => r.release())); assert.equal(await control.zcard(held.keys[0]), 0);
});

test('same-wallet exclusion survives renewals; replica configuration/key mismatch cannot reset it', async t => {
  const f = await fixture(t, { leaseMs: 1000, renewMs: 200 }); const a = await f.service(), b = await f.service();
  const reservation = await a.acquire('ak_owner');
  await sleep(1300); assert.equal(reservation.signal.aborted, false);
  await assert.rejects(b.acquire('ak_owner'), { status: 429 });
  const wrongLimit = await f.service({ ...f.limits, capacity: 3 });
  const wrongKey = await f.service(f.limits, randomBytes(32));
  await assert.rejects(wrongLimit.acquire('ak_new'), { status: 503 });
  await assert.rejects(wrongKey.acquire('ak_owner'), { status: 503 });
  await reservation.release(); const next = await b.acquire('ak_owner'); await next.release();
});

test('expired ownership cannot renew or release a replacement reservation', async t => {
  const f = await fixture(t, { leaseMs: 1000, renewMs: 200 }); const a = await f.service(), b = await f.service();
  const first = await a.acquire('ak_owner'), old = [...a.leases][0];
  clearTimeout(old.renewal); await sleep(1050); assert.equal(first.signal.aborted, true);
  const second = await b.acquire('ak_owner'), replacement = [...b.leases][0];
  await a.renew(old); assert.equal(first.signal.aborted, true);
  await first.release();
  assert.equal(await control.get(replacement.keys[1]), replacement.id);
  await assert.rejects(a.acquire('ak_owner'), { status: 429 }); await second.release();
});

test('delayed renewal acknowledgement cannot resurrect a local deadline', async t => {
  const f = await fixture(t, { leaseMs: 1000, renewMs: 200 }); const service = await f.service();
  const reservation = await service.acquire('ak_owner'), lease = [...service.leases][0]; clearTimeout(lease.renewal);
  const original = service.redis.eval.bind(service.redis), delayed = gate();
  service.redis.eval = async (...args) => { const result = await original(...args); await delayed.promise; return result; };
  const pending = service.renew(lease);
  try {
    await until(() => reservation.signal.aborted, 1500);
  } finally { delayed.resolve(); }
  await pending; assert.equal(reservation.signal.aborted, true); await reservation.release();
});

test('uncertain reservations are bounded, expire, and are not replayed after Redis recovery', async t => {
  const f = await fixture(t, { leaseMs: 1000, renewMs: 200 }); const service = await f.service();
  await control.call('CLIENT', 'PAUSE', '1700', 'ALL');
  const requests = Promise.allSettled(Array.from({ length: 80 }, (_, i) => service.acquire(`ak_owner${i}`)));
  await sleep(100); assert.ok(service.pending.size <= 32); assert.equal(service.redis.offlineQueue.length, 0);
  const results = await requests;
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.status === 503));
  await control.ping(); await until(() => !service.unavailable); await sleep(1100);
  const healthy = await service.acquire('ak_healthy'); await healthy.release();
  assert.equal(service.pending.size, 0);
});

test('two HTTP servers enforce capacity before multipart parsing, and aborted bodies release it', async t => {
  const f = await fixture(t); let calls = 0;
  const uploads = { part: async () => { calls++; return {}; } };
  const a = await f.api(uploads), b = await f.api(uploads);
  const one = f.slow(a, 'ak_one'); await until(() => a.admission.leases.size === 1);
  assert.equal(await f.slow(b, 'ak_one').result, 429);
  const two = f.slow(b, 'ak_two'); await until(() => b.admission.leases.size === 1);
  assert.equal(await f.slow(a, 'ak_three').result, 503); assert.equal(calls, 0);
  one.req.destroy(); two.req.destroy();
  await until(() => !a.admission.leases.size && !b.admission.leases.size);
  const response = await f.part(b, 'ak_one'); assert.equal(response.status, 201); await response.arrayBuffer(); assert.equal(calls, 1);
});

test('completed-body disconnect holds capacity until the handler settles; finish shares the same capacity', async t => {
  const hold = gate(), started = gate(); t.after(() => hold.resolve());
  const f = await fixture(t);
  const uploads = { shared: true, part: async () => { started.resolve(); await hold.promise; return {}; }, finish: async () => ({ status: 'queued' }) };
  const a = await f.api(uploads), b = await f.api(uploads); const controller = new AbortController();
  const request = f.part(a, 'ak_owner', controller.signal).catch(() => undefined); await started.promise;
  controller.abort(); await request;
  const finish = await fetch(b.base + '/shorts/uploads/owned/finish', { method: 'POST', headers: { Authorization: 'Bearer ak_owner', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(finish.status, 429); await finish.arrayBuffer();
  hold.resolve(); await until(() => !a.admission.leases.size);
  const accepted = await fetch(b.base + '/shorts/uploads/owned/finish', { method: 'POST', headers: { Authorization: 'Bearer ak_owner', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(accepted.status, 202); await accepted.arrayBuffer();
});

test('an unacknowledged reservation holds its wallet slot only until expiry and cannot be replayed', async t => {
  const f = await fixture(t, { leaseMs: 1000, renewMs: 200 }); const a = await f.service(), b = await f.service();
  const evaluate = a.redis.eval.bind(a.redis); let commits = 0;
  a.redis.eval = async (...args) => {
    const result = await evaluate(...args);
    if (result === 1) commits++;
    throw new Error('Fixture acknowledgement lost after Redis committed');
  };
  await assert.rejects(a.acquire('ak_owner'), { status: 503 });
  assert.equal(a.leases.size, 0); assert.equal(commits, 1);
  await assert.rejects(b.acquire('ak_owner'), { status: 429 });
  await sleep(1100);
  const recovered = await b.acquire('ak_owner'); await recovered.release();
  assert.equal(commits, 1, 'reconnecting must not repeat an unknown acquisition');
});

test('a request deadline aborts real private S3 IO; same-part retry recovers a committed object without duplicate metadata', async t => {
  const f = await fixture(t); let stored, first = true, closed = false, commits = 0;
  const storage = http.createServer(async (req, res) => {
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (stored) { res.writeHead(412); res.end(); return; }
      stored = Buffer.concat(chunks); // The provider committed; delay its response.
      if (first) { first = false; res.on('close', () => { closed = true; }); return; }
      res.end();
    } else { res.writeHead(200, { 'Content-Length': stored.length }); res.end(stored); }
  });
  storage.listen(0, '127.0.0.1'); await once(storage, 'listening');
  const objects = new ShortsPrivateObjectsService({ endpoint: `http://127.0.0.1:${storage.address().port}`, region: 'us-east-1', bucket: 'owned-fixture', prefix: 'private', forcePathStyle: true,
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, activeKeyId: 'v1', keys: { v1: randomBytes(32) } });
  t.after(async () => { objects.onModuleDestroy(); storage.closeAllConnections(); await new Promise(resolve => storage.close(resolve)); });
  const bytes = Buffer.from('owned bytes');
  const upload = { id: 'owned', creator: 'ak_owner', state: 'uploading', expiresAt: Date.now() + 60000, parts: [],
    input: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  const records = { get: async () => upload, part: async (_scope, _id, _actor, index, object) => { commits++; upload.parts.push({ index, object }); return object; } };
  const metadata = { verifyRuntime: async () => {}, verifyHostedStorage: async () => {} };
  const source = new ShortsSourceService(records, objects, metadata);
  const hosted = new ShortsHostedUploadsService({ shared: true, chain: f.chain }, metadata, records, source);
  const a = await f.api(hosted, { timeout: 1000 });
  const timedOut = await f.part(a, 'ak_owner'); assert.equal(timedOut.status, 503); await timedOut.arrayBuffer();
  await until(() => closed && !a.admission.leases.size);
  assert.equal(commits, 0, 'aborted IO cannot attach an unacknowledged part');
  const resumed = await f.part(a, 'ak_owner'); assert.equal(resumed.status, 201); await resumed.arrayBuffer();
  assert.equal(commits, 1); assert.equal(upload.parts.length, 1);
  assert.ok(!stored.includes(bytes), 'private bytes are encrypted');
});

test('losing the shared reservation aborts parsing; shutdown cancels an active handler before releasing capacity', async t => {
  const f = await fixture(t); const ended = gate(); let signal;
  const uploads = { shared: true, part: async (_actor, _id, _index, _bytes, cancellation) => {
    signal = cancellation;
    await new Promise((_, reject) => signal.addEventListener('abort', () => { ended.resolve(); reject(signal.reason); }, { once: true }));
  } };
  const a = await f.api(uploads);
  const slow = f.slow(a, 'ak_slow'); await until(() => a.admission.leases.size === 1);
  const lease = [...a.admission.leases][0]; await control.zrem(lease.keys[0], lease.id);
  await a.admission.renew(lease); assert.equal(await slow.result, 'closed');
  await until(() => !a.admission.leases.size);
  const request = f.part(a, 'ak_owner'); await until(() => signal);
  await a.app.get(ShortsUploadInterceptor).onModuleDestroy(); await ended.promise;
  const response = await request; assert.equal(response.status, 503); await response.arrayBuffer();
  assert.equal(signal.aborted, true); assert.equal(a.admission.leases.size, 0);
});

test('hosted upload interception cannot omit shared admission; invalid settings reject startup', async () => {
  const interceptor = new ShortsUploadInterceptor({ shared: true, authenticate: async () => 'ak_owner' });
  await assert.rejects(interceptor.intercept({ switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) }, {}), { status: 503 });
  for (const capacity of [0, 65, NaN, 1.5]) assert.throws(() => new ShortsUploadAdmissionService({ key: randomBytes(32) }, {}, { capacity, leaseMs: 30000, renewMs: 10000 }), /SHORTS_SHARED_CONCURRENT_UPLOADS/);
});

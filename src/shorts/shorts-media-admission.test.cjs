require('reflect-metadata');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const Redis = require('ioredis');
const { NestFactory } = require('@nestjs/core');
const { DataSource } = require('typeorm');
const { ShortsMediaAdmissionService, ShortsMediaUnavailableError, SHORTS_MEDIA_ADMISSION_LIMITS } = require('./shorts-media-admission.service');
const { ShortsUploadAdmissionService } = require('./shorts-upload-admission.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { ShortsModerationUnavailableError } = require('./shorts-safety.service');
const { ShortsChainService } = require('./shorts-chain.service');
const { ShortsHostedHostingService } = require('./shorts-hosted-hosting.service');
const { ShortsLifecycleJobsService } = require('./shorts-lifecycle-jobs.service');
const { SHORTS_RATE_CONFIG } = require('./shorts-rate.config');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsLifecycle1791763213000 } = require('../migrations/1791763213000-ShortsLifecycle');
const { ShortsMediaAdmission1791763225000 } = require('../migrations/1791763225000-ShortsMediaAdmission');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error('Condition did not become true');
}
let port, processRedis, directory, control;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'shorts-media-admission-'));
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  port = server.address().port; await new Promise(resolve => server.close(resolve));
  processRedis = spawn('redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--dir', directory,
    '--save', '', '--appendonly', 'no', '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction']);
  await new Promise((resolve, reject) => {
    processRedis.on('error', reject); processRedis.on('exit', code => reject(new Error(`Redis exited ${code}`)));
    processRedis.stdout.on('data', chunk => { if (String(chunk).includes('Ready to accept connections')) resolve(); });
  });
  control = new Redis({ host: '127.0.0.1', port }); await control.ping();
});
after(async () => {
  control?.disconnect();
  if (processRedis && processRedis.exitCode === null) { processRedis.kill('SIGTERM'); await once(processRedis, 'exit'); }
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(t) {
  const network = process.env.AE_NETWORK_ID; process.env.AE_NETWORK_ID = 'ae_uat';
  const config = { key: randomBytes(32), redis: { host: '127.0.0.1', port }, client: () => 'loopback' };
  const contract = `ct_${randomUUID().replaceAll('-', '')}`;
  const chain = { release: { network: 'ae_uat', contract }, state: { contract, sourceHash: 'a'.repeat(64) } };
  const limits = { capacity: 2, leaseMs: 2000, renewMs: 400 }, services = [], media = [], apps = [];
  t.after(async () => {
    for (const value of media) await value.onModuleDestroy();
    for (const app of apps) await app.close();
    for (const service of services) await service.beforeApplicationShutdown();
    if (network === undefined) delete process.env.AE_NETWORK_ID; else process.env.AE_NETWORK_ID = network;
  });
  async function admission(settings = limits, key = config.key, Class = ShortsMediaAdmissionService) {
    const app = await NestFactory.createApplicationContext({ module: class Admission {}, providers: [Class,
      { provide: SHORTS_RATE_CONFIG, useValue: { ...config, key } }, { provide: ShortsChainService, useValue: chain },
      { provide: SHORTS_MEDIA_ADMISSION_LIMITS, useValue: settings },
    ] }, { logger: false });
    apps.push(app); return app.get(Class);
  }
  function service(admission, source, safety) {
    const value = new ShortsMediaService(safety || { scan: async () => ({ status: 'no_flags' }) },
      source || { original: async () => Buffer.from('owned'), file: async () => Buffer.from('preview') },
      { shared: true, chain }, undefined, admission);
    media.push(value); return value;
  }
  return { admission, service, config, chain, limits, services };
}
const short = (creator = 'ak_creator') => ({ id: 'owned', creator, cid: 'bafyowned', privateMedia: {} });

test('two media instances share a renewed global limit and one operation per creator before reading bytes', async t => {
  const finish = gate(); t.after(() => finish.resolve());
  const f = await fixture(t), a = await f.admission(), b = await f.admission();
  let scans = 0, reads = 0;
  const source = { original: async () => { reads++; return Buffer.from('owned'); }, file: async () => { reads++; return Buffer.from('preview'); } };
  const safety = { scan: async () => { scans++; await finish.promise; return { status: 'no_flags' }; } };
  const one = f.service(a, source, safety), two = f.service(b, source, safety);
  const first = one.rescan(short('ak_one')), second = two.rescan(short('ak_two'));
  await until(() => scans === 2);
  await assert.rejects(two.preview(short('ak_three')), { status: 503 });
  await assert.rejects(two.rescan(short('ak_one')), { status: 503 });
  assert.equal(reads, 2);
  await pause(2200);
  await assert.rejects(two.preview(short('ak_three')), { status: 503 });
  const upload = new ShortsUploadAdmissionService(f.config, f.chain, f.limits); f.services.push(upload);
  await upload.onApplicationBootstrap(); const separate = await upload.acquire('ak_one'); await separate.release();
  finish.resolve(); await Promise.all([first, second]);
  assert.equal(String(await two.preview(short('ak_three'))), 'preview');
  assert.equal(a.leases.size + b.leases.size, 0);
});

test('policy/key disagreement and missing providers fail closed before private reads', async t => {
  const f = await fixture(t), a = await f.admission(); const held = await a.acquire('ak_owner');
  for (const b of [await f.admission({ ...f.limits, capacity: 3 }), await f.admission(f.limits, randomBytes(32))])
    await assert.rejects(b.acquire('ak_other'), { status: 503 });
  let reads = 0;
  const missing = f.service(undefined, { original: async () => { reads++; } });
  await assert.rejects(missing.rescan(short()), { status: 503 }); assert.equal(reads, 0);
  await held.release();
  for (const capacity of [0, 65, NaN, 1.5]) assert.throws(() => new ShortsMediaAdmissionService(f.config, f.chain,
    { ...f.limits, capacity }), /SHORTS_SHARED_CONCURRENT_MEDIA/);
});

test('cancellation retains admission until private reads drain and never starts a late scan', async t => {
  const finish = gate(); t.after(() => finish.resolve());
  const f = await fixture(t), a = await f.admission(), b = await f.admission(), entered = gate();
  let scans = 0, signal;
  const media = f.service(a, { original: async (_scope, _short, value) => { signal = value; entered.resolve(); await finish.promise; return Buffer.from('late'); } },
    { scan: async () => { scans++; } });
  const stop = new AbortController(), pending = media.rescan(short(), stop.signal).then(() => null, error => error);
  await entered.promise; stop.abort(); assert.equal(signal.aborted, true);
  await assert.rejects(b.acquire('ak_creator'), { status: 503 });
  finish.resolve(); assert.ok(await pending); assert.equal(scans, 0);
  const next = await b.acquire('ak_creator'); await next.release();
});

test('lost leases abort original reads and shutdown drains active media before returning', async t => {
  const finish = gate(); t.after(() => finish.resolve());
  const f = await fixture(t), a = await f.admission(), entered = gate(), aborted = gate();
  const media = f.service(a, { original: async (_scope, _short, signal) => {
    entered.resolve(); signal.addEventListener('abort', aborted.resolve, { once: true }); await finish.promise; return Buffer.from('late');
  } }, { scan: async () => assert.fail('Lost admission must prevent inspection') });
  const result = media.rescan(short()).then(() => null, error => error); await entered.promise;
  const lease = [...a.leases][0]; await control.zrem(lease.keys[0], lease.id); await aborted.promise;
  let stopped = false; const close = media.onModuleDestroy().then(() => { stopped = true; });
  await pause(40); assert.equal(stopped, false); finish.resolve(); assert.ok(await result); await close;
  await assert.rejects(media.preview(short())); assert.equal(a.leases.size, 0);
});

test('nested pin and integrity verification use one reservation and cancel every transfer', async t => {
  const f = await fixture(t), a = await f.admission(), media = f.service(a);
  let acquired = 0, pins = 0, verified = 0;
  const acquire = a.acquire.bind(a); a.acquire = async actor => { acquired++; return acquire(actor); };
  media.pinned = async () => false;
  media.pinPackage = async (_short, signal) => { assert.equal(signal.aborted, false); pins++; };
  await media.ensurePinned(short()); assert.equal(acquired, 1); assert.equal(pins, 1);
  media.pinned = async () => true;
  media.retrieveFile = async (_short, _name, signal) => { assert.equal(signal.aborted, false); verified++; };
  await media.ensurePinned({ ...short(), files: [{ name: 'video.mp4' }, { name: 'poster.jpg' }] });
  assert.equal(acquired, 2); assert.equal(verified, 2); assert.equal(a.leases.size, 0);
});

test('lost media admission returns retryable unavailability without accepting late scan evidence', async t => {
  const finish = gate(); t.after(() => finish.resolve());
  const f = await fixture(t), a = await f.admission(), entered = gate(), aborted = gate();
  const media = f.service(a, undefined, { scan: async (_original, signal) => {
    entered.resolve(); signal.addEventListener('abort', aborted.resolve, { once: true });
    await finish.promise; return { status: 'no_flags' };
  } });
  const result = media.rescan(short()).then(() => null, error => error); await entered.promise;
  const lease = [...a.leases][0]; await control.zrem(lease.keys[0], lease.id); await aborted.promise;
  finish.resolve(); const error = await result;
  assert.ok(error instanceof ShortsMediaUnavailableError); assert.equal(error.status, 503);
  assert.equal(a.leases.size, 0);
  const recovered = await a.acquire('ak_creator'); await recovered.release();
});

test('scanner backpressure returns a retryable capacity response without creating safety evidence', async t => {
  const f = await fixture(t), a = await f.admission();
  const media = f.service(a, undefined, { scan: async (_original, signal, retryUnavailable) => {
    assert.equal(signal.aborted, false); assert.equal(retryUnavailable, true); throw new ShortsModerationUnavailableError();
  } });
  await assert.rejects(media.rescan(short()), error => error instanceof ShortsMediaUnavailableError && error.status === 503);
  assert.equal(a.leases.size, 0);
});

test('a killed media owner releases only by lease expiry and another process can recover', async t => {
  const f = await fixture(t), other = await f.admission();
  const code = `const {ShortsMediaAdmissionService}=require('./src/shorts/shorts-media-admission.service');
    const f=JSON.parse(process.env.SHORTS_TEST_ADMISSION);
    (async()=>{const s=new ShortsMediaAdmissionService({...f.config,key:Buffer.from(f.key,'hex')},f.chain,f.limits);
    await s.onApplicationBootstrap(); await s.acquire('ak_killed'); process.send('held'); setInterval(()=>{},1000);})().catch(()=>process.exit(1));`;
  const child = spawn(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', '-e', code],
    { cwd: process.cwd(), env: { ...process.env, SHORTS_TEST_ADMISSION: JSON.stringify({ config: { redis: f.config.redis }, key: f.config.key.toString('hex'), chain: f.chain, limits: f.limits }) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
  assert.equal((await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Child exited before admission'); })]))[0], 'held');
  await assert.rejects(other.acquire('ak_killed'), { status: 503 });
  child.kill('SIGKILL'); await once(child, 'exit');
  let recovered;
  await until(async () => { try { recovered = await other.acquire('ak_killed'); return true; } catch { return false; } });
  await recovered.release();
});

test('HTTP storage capacity waits survive database claims and defer publication until verified recovery', {
  skip: !process.env.SHORTS_TEST_PG_URL, timeout: 45000,
}, async t => {
  const f = await fixture(t), admission = await f.admission();
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const schema = `shorts_media_${randomUUID().replaceAll('-', '')}`;
  const admin = await new DataSource({ type: 'postgres', url: url.href }).initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const db = await new DataSource({ type: 'postgres', url: url.href, extra: { options: `-c search_path=${schema}` } }).initialize();
  t.after(async () => { await db.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.destroy(); });
  await new ShortsMetadata1791763200000().up(db); await new ShortsLifecycle1791763213000().up(db);
  const scope = f.chain.release, hash = f.chain.state.sourceHash;
  await db.query('INSERT INTO shorts_runtime VALUES($1,$2,$3,NULL,8,2)', [scope.network, scope.contract, hash]);
  const jobs = new ShortsLifecycleJobsService(db);
  await assert.rejects(jobs.verify(scope, hash), { status: 503 });
  await new ShortsMediaAdmission1791763225000().up(db); await jobs.verify(scope, hash);
  const bytes = Buffer.from('owned durable storage recovery fixture');
  const cid = await new ShortsPackageService().cid([{ name: 'video.mp4', data: bytes }]);
  const video = { ...short(), cid, bytes: bytes.length, moderation: 'approved', safety: { status: 'no_flags' }, publication: 'pending',
    files: [{ name: 'video.mp4', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  await db.query('INSERT INTO shorts_content(network,contract,id,creator,created_at,body) VALUES($1,$2,$3,$4,1,$5)',
    [scope.network, scope.contract, video.id, video.creator, video]);
  await db.query('UPDATE shorts_lifecycle_jobs SET attempts=3');
  let status = 503, adds = 0, reads = 0, enqueued = 0, journal;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.startsWith('/api/v0/pin/ls?')) {
        res.writeHead(500); res.end(JSON.stringify({ Code: 0, Message: `path '${cid}' is not pinned` }));
      } else if (req.url.startsWith('/api/v0/add?')) {
        adds++; res.writeHead(status);
        res.end(status === 200 ? JSON.stringify({ Hash: cid }) : 'storage unavailable');
      } else if (req.url.startsWith('/api/v0/cat?')) { reads++; res.end(bytes); }
      else { res.writeHead(404); res.end(); }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const keys = ['SHORTS_IPFS_API', 'SHORTS_IPFS_TOKEN_FILE', 'SHORTS_IPFS_APIS', 'SHORTS_IPFS_CREDENTIALS_FILE'];
  const saved = keys.map(key => process.env[key]);
  keys.forEach(key => { delete process.env[key]; });
  process.env.SHORTS_IPFS_API = `http://127.0.0.1:${server.address().port}/api/v0`;
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  }));
  const media = f.service(admission, { file: async () => bytes });
  // Chain and publisher boundaries are controlled here; HTTP transfer, CID/hash
  // verification, Redis admission, PostgreSQL claims and lifecycle are real.
  const chain = { ...f.chain, read: async () => video.publication === 'published'
    ? { creator: video.creator, cid, size: video.bytes } : undefined };
  const shorts = { matchesPublication: () => true, publisher: {
    status: async () => journal, capacity: async () => true,
    enqueue: async (id, creator) => {
      assert.equal(id, video.id); assert.equal(creator, video.creator);
      assert.equal(media.hasPin(cid), true); assert.equal(reads, 1);
      enqueued++; journal = { status: 'queued' };
    },
  } };
  const records = { get: async id => (await db.query(
    'SELECT body FROM shorts_content WHERE network=$1 AND contract=$2 AND id=$3',
    [scope.network, scope.contract, id],
  ))[0].body };
  const worker = new ShortsHostedHostingService(chain, media, shorts, records, jobs);
  t.after(() => worker.onModuleDestroy());
  for (status of [503, 429]) {
    await db.query('UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()');
    await worker.reconcile();
    const [row] = await db.query('SELECT attempts,result,next_at>clock_timestamp() AS delayed FROM shorts_lifecycle_jobs');
    assert.deepEqual(row, { attempts: 3, result: 'capacity_wait', delayed: true });
    assert.equal((await jobs.health(scope)).capacityWaiting, 1); assert.equal(await jobs.claim(scope), undefined);
    assert.equal(enqueued, 0); assert.equal(reads, 0); assert.equal(media.hasPin(cid), false);
    assert.equal(admission.leases.size, 0);
  }
  await assert.rejects(new ShortsMediaAdmission1791763225000().down(db), { code: '23514' });
  await jobs.verify(scope, hash);
  status = 403;
  await db.query('UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()'); await worker.reconcile();
  const [denied] = await db.query('SELECT attempts,result FROM shorts_lifecycle_jobs');
  assert.deepEqual(denied, { attempts: 4, result: 'failed' });
  assert.equal(enqueued, 0); assert.equal(reads, 0);
  status = 200;
  await db.query('UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()'); await worker.reconcile();
  const [pending] = await db.query('SELECT attempts,result FROM shorts_lifecycle_jobs');
  assert.deepEqual(pending, { attempts: 0, result: 'publication_pending' });
  assert.equal(adds, 4); assert.equal(enqueued, 1); assert.equal(reads, 1);
  await db.query('UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()'); await worker.reconcile();
  assert.equal(adds, 4, 'journaled publication must not upload or enqueue again'); assert.equal(enqueued, 1);
  video.publication = 'published';
  await db.query('UPDATE shorts_content SET body=$1 WHERE id=$2', [video, video.id]);
  await db.query('UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp()'); await worker.reconcile();
  const [ready] = await db.query('SELECT attempts,result FROM shorts_lifecycle_jobs');
  assert.deepEqual(ready, { attempts: 0, result: 'checked' });
  assert.equal(enqueued, 1); assert.equal(admission.leases.size, 0);
});

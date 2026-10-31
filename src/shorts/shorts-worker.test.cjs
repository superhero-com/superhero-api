const { directUploadPart } = require('./testing/direct-upload.cjs');
const { ShortsDirectUploads1792022400000 } = require('../migrations/1792022400000-ShortsDirectUploads');
const { releaseFixture } = require('./shorts-release.fixture.cjs');
const { ShortsLifecycle1791763213000 } = require('../migrations/1791763213000-ShortsLifecycle');
const { ShortsLifecycleJobsService } = require('./shorts-lifecycle-jobs.service');
const { ShortsHostedHostingService } = require('./shorts-hosted-hosting.service');
const { ShortsWorkerBackpressure1791763222000 } = require('../migrations/1791763222000-ShortsWorkerBackpressure');
const { ShortsUploadBudget1791763224000 } = require('../migrations/1791763224000-ShortsUploadBudget');
const { ShortsMediaAdmission1791763225000 } = require('../migrations/1791763225000-ShortsMediaAdmission');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { mkdtemp, writeFile, readFile, rm, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync, fork } = require('node:child_process');
const { once } = require('node:events');
const { DataSource } = require('typeorm');
const { NestFactory } = require('@nestjs/core');
const { Module, Global, UnauthorizedException } = require('@nestjs/common');
const { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const { shortsWorkerConfig } = require('./shorts-worker.config');
const { ShortsEncodingService } = require('./shorts-encoding.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsMetadataModule } = require('./shorts-metadata.module');
const { ShortsSharedUploadsModule } = require('./shorts-shared-uploads.module');
const { ShortsPrivateMediaService } = require('./shorts-private-media.service');
const { ShortsRecordsService } = require('./shorts-records.service');
const { ShortsController } = require('./shorts.controller');
const { ShortsService } = require('./shorts.service');
const { ShortsAuthService } = require('./shorts-auth.service');
const { ShortsAuthGuard } = require('./shorts-auth.guard');
const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
const { ShortsUploadsService } = require('./shorts-uploads.service');
const { ShortsHostedUploadsService } = require('./shorts-hosted-uploads.service');
const { ShortsStoreService } = require('./shorts-store.service');
const { ShortsMetadata1791763200000 } = require('../migrations/1791763200000-ShortsMetadata');
const { ShortsUploads1791763202000 } = require('../migrations/1791763202000-ShortsUploads');
const { ShortsWorkers1791763203000 } = require('../migrations/1791763203000-ShortsWorkers');
const { ShortsWorkerAuthority1791763204000 } = require('../migrations/1791763204000-ShortsWorkerAuthority');
const { ShortsStreamingOutbox1791763206000 } = require('../migrations/1791763206000-ShortsStreamingOutbox');
const { workerRole } = require('./testing/worker-role.cjs');
const { ShortsSharedCutover1791763214000 } = require('../migrations/1791763214000-ShortsSharedCutover');
const { ShortsProcessingCapacity1791763215000 } = require('../migrations/1791763215000-ShortsProcessingCapacity');
const { ShortsLegacyImportsService } = require('./shorts-legacy-imports.service');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('worker startup rejects wrong networks, bypasses and unnecessary credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-worker-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'deployment.json');
  const manifest = releaseFixture({ sourceHash: hash('contract') }).release;
  await writeFile(path, JSON.stringify(manifest));
  const env = { ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_TESTNET_MVP: '1', SHORTS_DEPLOYMENT_FILE: path };
  assert.equal((await shortsWorkerConfig(env)).scope.contract, manifest.contract);
  for (const override of [{ AE_NETWORK_ID: 'ae_mainnet' }, { ENABLE_SHORTS: 'false' }, { SHORTS_DEMO_AUTO_APPROVE: '1' },
    { SHORTS_DEMO_CONNECTED_WALLET: '1' }, { SHORTS_OPERATOR_KEY_FILE: '/forbidden/signer' }, { SHORTS_IPFS_TOKEN_FILE: '/forbidden/ipfs' },
    { SHORTS_STREAM_KEY_FILE: '/forbidden/stream' }, { SHORTS_WORKER_LEASE_MS: '0' }, { SHORTS_WORKER_TMP_DIR: 'relative' },
    { SHORTS_WORKER_MIN_FREE_BYTES: '0' }, { SHORTS_WORKER_MIN_FREE_BYTES: '1e9' },
    { SHORTS_WORKER_MIN_FREE_INODES: '127' }, { SHORTS_WORKER_MAX_USED_PERCENT: '100' }]) await assert.rejects(shortsWorkerConfig({ ...env, ...override }));
});

test('encoder rejects invalid input and cleans its private temporary directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-encoding-')); const saved = process.env.SHORTS_WORKER_TMP_DIR;
  process.env.SHORTS_WORKER_TMP_DIR = dir;
  t.after(async () => { if (saved === undefined) delete process.env.SHORTS_WORKER_TMP_DIR; else process.env.SHORTS_WORKER_TMP_DIR = saved; await rm(dir, { recursive: true, force: true }); });
  const { ShortsScratchService, ShortsScratchProbeService } = require('./shorts-scratch.service');
  const scratch = new ShortsScratchService({ directory: dir, minFreeBytes: 1048576, minFreeInodes: 128, maxUsedPercent: 99 }, new ShortsScratchProbeService());
  await scratch.onModuleInit(); t.after(() => scratch.onModuleDestroy());
  const encoder = new ShortsEncodingService(scratch);
  await assert.rejects(encoder.encode(Buffer.from('not a video'), 'Test', 'Art'));
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(encoder.encode(Buffer.from('not a video'), 'Test', 'Art', {}, AbortSignal.abort()));
  assert.deepEqual(await readdir(dir), []);
});

test('local UnixFS package identity matches actual offline Kubo for chunks and file ordering', { skip: !process.env.SHORTS_TEST_KUBO_API }, async () => {
  const endpoint = new URL(process.env.SHORTS_TEST_KUBO_API); assert.equal(endpoint.hostname, '127.0.0.1');
  const service = new ShortsPackageService();
  for (const bytes of [5, 262144, 262145, 1048600]) {
    const files = [{ name: 'video.mp4', data: Buffer.alloc(bytes, 42) }, { name: 'poster.jpg', data: Buffer.from('owned-poster') }, { name: 'manifest.json', data: Buffer.from('{}') }];
    const form = new FormData(); for (const file of files) form.append('file', new Blob([file.data]), file.name);
    const response = await fetch(`${endpoint.href}/add?wrap-with-directory=true&cid-version=1&raw-leaves=true&chunker=size-262144&pin=false&only-hash=true`, { method: 'POST', body: form });
    assert.equal(response.status, 200); const cid = (await response.text()).trim().split('\n').map(JSON.parse).at(-1).Hash;
    assert.equal(await service.cid(files), cid); assert.equal(await service.cid([...files].reverse()), cid);
  }
});

test('hosted HTTP uploads survive a killed media worker and publish only through the approved API path', {
  skip: !process.env.SHORTS_TEST_PG_URL || !process.env.SHORTS_TEST_S3_ENDPOINT, timeout: 120000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-worker-flow-')); const saved = { ...process.env };
  const url = new URL(process.env.SHORTS_TEST_PG_URL); assert.equal(url.hostname, '127.0.0.1');
  const endpoint = new URL(process.env.SHORTS_TEST_S3_ENDPOINT); assert.equal(endpoint.hostname, '127.0.0.1');
  const schema = `shorts_worker_${randomUUID().replaceAll('-', '')}`;
  const admin = new DataSource({ type: 'postgres', url: url.href }); await admin.initialize(); await admin.query(`CREATE SCHEMA ${schema}`);
  const options = { type: 'postgres', url: url.href, schema, extra: { options: `-c search_path=${schema}`, max: 8 }, synchronize: false,
    migrations: [ShortsMetadata1791763200000, ShortsLifecycle1791763213000, ShortsUploads1791763202000, ShortsWorkers1791763203000, ShortsWorkerAuthority1791763204000, ShortsStreamingOutbox1791763206000, ShortsSharedCutover1791763214000, ShortsProcessingCapacity1791763215000, ShortsWorkerBackpressure1791763222000, ShortsUploadBudget1791763224000, ShortsMediaAdmission1791763225000, ShortsDirectUploads1792022400000] };
  const a = new DataSource(options), b = new DataSource(options); await a.initialize(); await b.initialize(); await a.runMigrations({ transaction: 'all' });
  const scope = { network: 'ae_uat', contract: releaseFixture().release.contract }, sourceHash = hash('test-contract');
  const metadata = new ShortsMetadataService(a); await metadata.initialize(scope, sourceHash);
  const workerIdentity = await workerRole(admin, { url: url.href, schema, scope });
  const bucket = `shorts-worker-${randomUUID()}`, credentials = { accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY, secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY };
  const raw = new S3Client({ endpoint: endpoint.origin, region: 'us-east-1', forcePathStyle: true, credentials, requestChecksumCalculation: 'WHEN_REQUIRED' });
  await raw.send(new CreateBucketCommand({ Bucket: bucket }));
  await writeFile(join(dir, 's3.json'), JSON.stringify(credentials), { mode: 0o600 });
  await writeFile(join(dir, 'keys.json'), JSON.stringify({ activeKeyId: 'key1', keys: { key1: randomBytes(32).toString('hex') } }), { mode: 0o600 });
  await writeFile(join(dir, 'deployment.json'), JSON.stringify(releaseFixture({ ...scope, sourceHash }).release));
  Object.assign(process.env, { NODE_ENV: 'test', ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_TESTNET_MVP: '1', SHORTS_DEMO_AUTO_APPROVE: '0', SHORTS_DEMO_CONNECTED_WALLET: '0',
    SHORTS_PRIVATE_S3_ENDPOINT: endpoint.origin, SHORTS_PRIVATE_S3_UPLOAD_ENDPOINT: endpoint.origin, SHORTS_PRIVATE_S3_ALLOW_LOOPBACK: '1', SHORTS_PRIVATE_S3_REGION: 'us-east-1', SHORTS_PRIVATE_S3_BUCKET: bucket,
    SHORTS_PRIVATE_S3_CREDENTIALS_FILE: join(dir, 's3.json'), SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE: join(dir, 'keys.json'),
    SHORTS_DEPLOYMENT_FILE: join(dir, 'deployment.json'), SHORTS_WORKER_LEASE_MS: '1200', SHORTS_TEST_SCHEMA: schema, SHORTS_WORKER_TMP_DIR: dir, SHORTS_WORKER_MAX_USED_PERCENT: '99' });
  for (const key of ['SHORTS_OPERATOR_KEY_FILE', 'SHORTS_IPFS_TOKEN_FILE', 'SHORTS_STREAM_KEY_FILE', 'SHORTS_DATA_DIR', 'SHORTS_IMPORT_LEGACY_CONTENT', 'SHORTS_IMPORT_LEGACY_ANALYTICS', 'SHORTS_IMPORT_LEGACY_RECEIPTS']) delete process.env[key];
  const apps = [], children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    for (const app of apps) await app.close();
    await a.destroy(); await b.destroy(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await workerIdentity.dispose(); await admin.destroy();
    const listed = await raw.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (listed.Contents?.length) await raw.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: listed.Contents.map(object => ({ Key: object.Key })) } }));
    await raw.send(new DeleteBucketCommand({ Bucket: bucket })); raw.destroy(); process.env = saved; await rm(dir, { recursive: true, force: true });
  });
  async function api(db) {
    const chain = { release: releaseFixture({ ...scope, sourceHash }).release, state: { ...scope, sourceHash, shorts: [] }, address: value => value, serial: () => assert.fail('Hosted uploads cannot wait on chain mutations') };
    const records = new ShortsRecordsService(chain, new ShortsMetadataService(db));
    class DatabaseModule {} Global()(DatabaseModule); Module({ providers: [{ provide: DataSource, useValue: db }], exports: [DataSource] })(DatabaseModule);
    const app = await NestFactory.create({ module: class ApiTestModule {}, imports: [DatabaseModule, ShortsSharedUploadsModule, ShortsMetadataModule], controllers: [ShortsController], providers: [
      ShortsAuthGuard, ShortsUploadInterceptor, { provide: ShortsRecordsService, useValue: records }, ShortsStoreService,
      { provide: ShortsUploadsService, useClass: ShortsHostedUploadsService },
      { provide: ShortsService, useValue: { chain } },
      { provide: ShortsAuthService, useValue: { authenticate: async auth => { if (!['Bearer creator', 'Bearer another'].includes(auth)) throw new UnauthorizedException(); return auth === 'Bearer creator' ? 'ak_creator' : 'ak_another'; } } },
    ] }, { logger: false }); apps.push(app); await app.listen(0, '127.0.0.1');
    assert.equal(app.get(ShortsStoreService).shared, true); assert.throws(() => app.get(ShortsStoreService).db, /unavailable in the hosted API/);
    return { app, base: await app.getUrl(), records };
  }
  const apiA = await api(a), apiB = await api(b);
  const path = join(dir, 'input.mp4'); execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=72x128:r=12', '-t', '2.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
  const video = await readFile(path);
  const request = { title: 'Owned synthetic short', topic: 'Art', rights: true, bytes: video.length, sha256: hash(video), details: { language: 'und' } };
  const response = await fetch(apiA.base + '/shorts/uploads', { method: 'POST', headers: { Authorization: 'Bearer creator', 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(response.status, 201); const upload = await response.json();
  const json = async (api, path, body, token) => {
    const response = await fetch(api.base + '/shorts' + path, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await directUploadPart(json, apiB, upload.id, 0, video, 'creator')).status, 201);
  const finish = await fetch(apiA.base + `/shorts/uploads/${upload.id}/finish`, { method: 'POST', headers: { Authorization: 'Bearer creator' } }); assert.equal(finish.status, 202);
  assert.equal((await finish.json()).status, 'queued');
  assert.equal((await fetch(apiB.base + `/shorts/uploads/${upload.id}`, { headers: { Authorization: 'Bearer another' } })).status, 404);
  function child(paused) {
    const process = fork(join(__dirname, 'testing/media-worker.cjs'), [], { execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'],
      env: { ...global.process.env, SHORTS_TEST_PG_URL: workerIdentity.url, SHORTS_TEST_UPLOAD_ID: upload.id, SHORTS_TEST_PAUSE_ENCODING: paused ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(process); const messages = []; let errors = ''; process.on('message', message => messages.push(message)); process.stderr.on('data', data => { errors += data; }); process.stdout.resume();
    return { process, async wait(type) { for (let i = 0; i < 600; i++) { const message = messages.find(message => message.type === type); if (message) return message;
      if (type === 'result') { const job = await metadata.getJob(scope, 'ak_creator', upload.id); if (['ready', 'failed'].includes(job.status)) return job; }
      if (process.exitCode !== null || process.signalCode !== null) throw new Error(`Worker exited: ${errors}`); await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out waiting for worker ${type}: ${errors}`); } };
  }
  const first = child(true); await first.wait('encoding'); const leased = await metadata.getJob(scope, 'ak_creator', upload.id); assert.equal(leased.status, 'processing');
  first.process.kill('SIGKILL'); await once(first.process, 'exit');
  await new Promise(resolve => setTimeout(resolve, 1300));
  const second = child(false); const outcome = await second.wait('result'); assert.equal(outcome.status, 'ready'); assert.equal(outcome.attempts, 2); assert.equal(outcome.fence, '2');
  if (second.process.exitCode === null) { second.process.kill('SIGTERM'); await once(second.process, 'exit'); }
  const ready = await fetch(apiB.base + `/shorts/uploads/${upload.id}`, { headers: { Authorization: 'Bearer creator' } }); const status = await ready.json();
  assert.equal(status.status, 'ready'); assert.equal(status.video.moderation, 'pending'); assert.equal(JSON.stringify(status).includes('privateMedia'), false); assert.equal(JSON.stringify(status).includes(bucket), false);
  const stored = (await metadata.get(scope, upload.id)).record;
  assert.equal(stored.privateMedia.fence, '2'); assert.ok(Object.values(stored.privateMedia.files).every(ref => ref.key.includes(`/attempt/2/`)));
  assert.equal(stored.publication, undefined);
  const privateMedia = apiB.app.get(ShortsPrivateMediaService);
  assert.deepEqual(await privateMedia.original(scope, stored), video); assert.ok((await privateMedia.file(scope, stored, 'video.mp4')).length > 0);
  await assert.rejects(metadata.complete(scope, { id: leased.id, fence: leased.fence, leaseToken: leased.leaseToken }, { ...stored, privateMedia: { ...stored.privateMedia, fence: '1' } }), { status: 409 });
  await assert.rejects(metadata.change(scope, upload.id, current => { current.privateMedia.fence = '1'; }), { status: 409 });
  const snapshot = await metadata.get(scope, upload.id);
  const changedSource = structuredClone(snapshot.record);
  changedSource.privateMedia.source.sha256 = '0'.repeat(64);
  await assert.rejects(metadata.replace(scope, changedSource, snapshot.revision), { status: 409 });
  assert.deepEqual((await metadata.get(scope, upload.id)).record.privateMedia, stored.privateMedia);
  const publisher = new ShortsService({ ...apiB.records.chain, read: () => assert.fail('Pending content cannot reach a chain call') }, {}, {}, {}, {}, {}, {}, {}, apiB.records);
  await assert.rejects(publisher.publish('ak_creator', upload.id), { status: 403 });
  assert.equal((await metadata.get(scope, upload.id)).record.moderation, 'pending');
  if (process.env.SHORTS_TEST_KUBO_API) {
    process.env.SHORTS_IPFS_API = process.env.SHORTS_TEST_KUBO_API;
    const { ShortsMediaService } = require('./shorts-media.service');
    const media = new ShortsMediaService({ scan: async original => ({ status: 'no_flags', sourceSha256: hash(original) }) }, privateMedia, apiB.records, undefined, { acquire: async () => ({ signal: new AbortController().signal, release: async () => {} }) });
    assert.deepEqual(await media.preview(stored), await privateMedia.file(scope, stored, 'video.mp4'));
    assert.equal((await media.rescan(stored)).sourceSha256, hash(video));
    await metadata.change(scope, upload.id, current => { current.moderation = 'approved'; });
    let publication, job; let admissions = 0;
    const approvedPublisher = new ShortsService({ ...apiB.records.chain,
      read: async method => method === 'has_liked' ? false : publication,
      write: async () => assert.fail('Hosted API must not sign'),
    }, media, { counters: () => ({ views: 0 }) }, {}, {}, {}, { enqueue() {} }, {}, apiB.records, {
      async capacity() { return true; },
      async enqueue(id, creator) { assert.equal(id, upload.id); assert.equal(creator, 'ak_creator'); admissions++; job = { status: 'queued' }; },
      async status() { return job; },
    });
    const pending = await approvedPublisher.publish('ak_creator', upload.id);
    assert.equal(admissions, 0); assert.equal(pending.publicationRequest, 'preparing');
    const hosting = new ShortsHostedHostingService(approvedPublisher.chain, media, approvedPublisher, apiB.records, new ShortsLifecycleJobsService(b));
    await hosting.reconcile(); await hosting.onModuleDestroy();
    assert.equal(admissions, 1); assert.equal(pending.publicationPending, true); assert.equal(pending.publicationStatus, 'draft');
    publication = { creator: stored.creator, cid: stored.cid, size: stored.bytes, likes: 0n };
    assert.equal((await approvedPublisher.publication('ak_creator', upload.id)).publicationStatus, 'draft');
    // Chain submission/verification is exercised by the separate restricted-publisher suite.
    job.status = 'confirmed';
    const published = await approvedPublisher.publication('ak_creator', upload.id);
    assert.equal(published.status, 'active'); assert.equal(published.privateMedia, undefined);
    assert.deepEqual(await media.retrieve(stored, 'video.mp4'), await media.preview(stored));
    await approvedPublisher.publish('ak_creator', upload.id); assert.equal(admissions, 1);
  }

  // Hosted startup uses the durable cutover marker, never a local SQLite snapshot.
  const imports = new ShortsLegacyImportsService(a);
  await imports.cutover(scope, hash('legacy-snapshot'));
  const adapter = new ShortsHostedUploadsService(apiB.records, metadata, {}, {});
  await assert.rejects(adapter.initialize(), /Complete the offline/);
  await imports.cutover(scope, hash('legacy-snapshot'), true);
  await adapter.initialize();
});

const { releaseFixture } = require('./shorts-release.fixture.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { createServer } = require('node:net');
const { DataSource } = require('typeorm');
const Redis = require('ioredis');
const { AccountMemory, encode, Encoding } = require('@aeternity/aepp-sdk');
const { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsPublicationsService } = require('./shorts-publications.service');
const { publisherRole } = require('./testing/publisher-role.cjs');
const { workerRole } = require('./testing/worker-role.cjs');
const { Tx } = require('../mdw-sync/entities/tx.entity');
const { assembledIndex } = require('./testing/assembled-index.cjs');
const { assembledUploadLoad } = require('./testing/assembled-upload-load.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await pause(100); }
  throw new Error('Fixture condition did not become true');
}

test('complete hosted module shares upload, media and publication controls across process loss', {
  skip: !['PG_URL','REDIS_URL','S3_ENDPOINT','KUBO_API'].every(name => process.env[`SHORTS_TEST_${name}`]),
  timeout: process.env.SHORTS_TEST_UPLOAD_LOAD === '1' ? 420000 : 300000,
}, async t => {
  const endpoints = Object.fromEntries(['PG_URL','REDIS_URL','S3_ENDPOINT','KUBO_API'].map(name => [name, new URL(process.env[`SHORTS_TEST_${name}`])]));
  for (const endpoint of Object.values(endpoints)) assert.equal(endpoint.hostname, '127.0.0.1');
  const schema = `shorts_assembled_${randomUUID().replaceAll('-', '')}`, dir = await mkdtemp(join(tmpdir(), 'shorts-assembled-'));
  const scope = { network: 'ae_uat', contract: encode(randomBytes(32), Encoding.ContractAddress) }, sourceHash = hash('owned offline contract');
  const creator = AccountMemory.generate(), operator = AccountMemory.generate();
  const policy = { maxTransactionCost: '2000000000000000', rollingCostLimit: '10000000000000000', maxPending: 2,
    maxCreatorPending: 1, leaseMs: 3000, maxTtlBlocks: 20, confirmations: 3 };
  const admin = await new DataSource({ type: 'postgres', url: endpoints.PG_URL.href }).initialize();
  const children = [], fixtureRuntimes = [], roles = [], sockets = new Set();
  const compiled = process.env.SHORTS_TEST_COMPILED === '1';
  let owner, raw, redis, bucket, scanner, c;
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    for (const socket of sockets) socket.destroy(); if (scanner) await new Promise(resolve => scanner.close(resolve));
    if (redis) {
      const scopeHash = hash(`ae_uat:${scope.contract}`).slice(0, 32);
      for (const kind of ['rate','upload','media','ws']) { const keys = await redis.keys(`shorts:${kind}:v1:{${scopeHash}}:*`); if (keys.length) await redis.del(...keys); }
      redis.disconnect();
    }
    if (raw && bucket) {
      const list = await raw.send(new ListObjectsV2Command({ Bucket: bucket }));
      if (list.Contents?.length) await raw.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: list.Contents.map(o => ({ Key: o.Key })) } }));
      await raw.send(new DeleteBucketCommand({ Bucket: bucket })); raw.destroy();
    }
    if (owner?.isInitialized) await owner.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of roles) await role.dispose();
    await admin.destroy(); await rm(dir, { recursive: true, force: true });
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  owner = await new DataSource({ type: 'postgres', url: endpoints.PG_URL.href, schema, entities: [Tx], synchronize: true, extra: { options: `-c search_path=${schema}`, max: 4 } }).initialize();
  // Actual Tx entity plus minimal external sync tables; no remote MDW or chain finality.
  await owner.query(`CREATE TABLE sync_state(id text PRIMARY KEY,tip_height integer,updated_at timestamptz);
    CREATE TABLE plugin_failed_transaction(plugin_name text,tx_hash text); CREATE TABLE key_blocks(height integer PRIMARY KEY, hash text NOT NULL);`);
  const migrations = (await readdir(join(__dirname, '../migrations'))).filter(name => /^\d+-Shorts.*\.ts$/.test(name)).sort();
  await owner.transaction(async db => {
    for (const file of migrations) { const Migration = Object.values(require('../migrations/' + file))[0]; await new Migration().up(db.queryRunner); }
  });
  // The indexer owner binds first; read-only API roles only validate persisted ownership.
  await require('./testing/index-network.cjs').indexNetworkFixture(owner, { release: { ...scope }, state: { contract: scope.contract } });
  const social = await require('./testing/assembled-social.cjs').socialFixture(owner, dir);
  const meta = new ShortsMetadataService(owner); await meta.initialize(scope, sourceHash);
  await new ShortsPublicationsService(owner).initialize(scope, sourceHash, operator.address, policy);
  const apiRole = await publisherRole(admin, { url: endpoints.PG_URL.href, schema, scope, kind: 'api' }); roles.push(apiRole);
  const worker = await workerRole(admin, { url: endpoints.PG_URL.href, schema, scope }); roles.push(worker);
  const writeTables = ['shorts_content','shorts_runtime','shorts_auth_scopes','shorts_auth_challenges','shorts_auth_sessions',
    'shorts_upload_sessions','shorts_upload_parts','shorts_upload_admission','shorts_ingestion','shorts_measurement_settings',
    'shorts_measurement_viewers','shorts_measurement_plays','shorts_measurement_totals','shorts_stream_jobs','shorts_lifecycle_jobs'];
  const tables = new Set((await owner.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1`, [schema])).map(row => row.tablename));
  for (const table of tables) {
    if (/^shorts_(publishing|publication|publisher|worker_principals|retention|storage|hls|pin|multipart|upload_reservations)/.test(table)) continue;
    await owner.query(`GRANT SELECT${writeTables.includes(table) ? ',INSERT,UPDATE,DELETE' : ''} ON ${table} TO ${apiRole.role}`);
  }
  const credentials = { accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY || 'test', secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY || 'test' };
  raw = new S3Client({ endpoint: endpoints.S3_ENDPOINT.origin, region: 'us-east-1', forcePathStyle: true, credentials, requestChecksumCalculation: 'WHEN_REQUIRED' });
  bucket = `shorts-assembled-${randomUUID()}`; await raw.send(new CreateBucketCommand({ Bucket: bucket }));
  for (const [name, value] of Object.entries({
    'chain.json': JSON.stringify({ shorts: {}, height: 100 }),
    'deployment.json': JSON.stringify(releaseFixture({ ...scope, sourceHash, operator: operator.address }).release), 'policy.json': JSON.stringify(policy),
    's3.json': JSON.stringify(credentials), 'keys.json': JSON.stringify({ activeKeyId: 'key1', keys: { key1: randomBytes(32).toString('hex') } }),
    'rate.key': randomBytes(32).toString('hex'), 'scanner.key': randomBytes(32).toString('hex'),
  })) await writeFile(join(dir, name), value, { mode: 0o600 });
  let scans = 0, scannerMode = 'hold', heldResponse;
  scanner = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ready: true, accepting: true })); return; }
    if (req.url.startsWith('/v3/contracts/logs?')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [], next: null })); return; }
    assert.equal(req.url, '/inspect'); assert.equal(req.headers.authorization, 'Bearer ' + await readFile(join(dir, 'scanner.key'), 'utf8'));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    scans++; if (scannerMode === 'hold') { heldResponse = res; return; }
    if (scannerMode === 'busy') { res.writeHead(503); res.end(); return; }
    const sha256 = hash(Buffer.concat(chunks)), labels = [{ topic: 'Art', score: 0.9 }];
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ sourceSha256: sha256, status: 'no_flags',
      policy: 'visual-review-v1', evidenceHash: hash('owned evidence'), duration: 2.2, reason: 'Owned fixture response', sampling: 'owned fixture',
      frameCount: 5, maxNsfwScore: 0, labels, humanReviewRequired: true,
      models: { safety: { repository: 'fixture', revision: 'a'.repeat(40) }, topics: { repository: 'fixture', revision: 'b'.repeat(40) } },
      frames: [0,0.5,1,1.5,2].map(at => ({ at, sha256, nsfwScore: 0, labels })) }));
  });
  scanner.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  scanner.listen(0, '127.0.0.1'); await once(scanner, 'listening');
  let streamPort, webPort;
  if (process.env.SHORTS_TEST_STREAMING_REPO) {
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    streamPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    await writeFile(join(dir, 'stream.key'), randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  if (process.env.SHORTS_TEST_WEB_REPO) {
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    webPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  }
  const env = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' };
  for (const key of Object.keys(env)) if (/^(SHORTS_|AWS_|REDIS_)/.test(key)) delete env[key];
  Object.assign(env, { ...(social?.env || {}), NODE_ENV: 'test', ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_TESTNET_MVP: '1',
    SHORTS_TEST_COMPILED: compiled ? '1' : '0',
    SHORTS_DEMO_AUTO_APPROVE: '0', SHORTS_DEMO_CONNECTED_WALLET: '0', SHORTS_WEB_ORIGIN: `http://127.0.0.1:${webPort || 5180}`,
    SHORTS_PRIVATE_S3_ENDPOINT: endpoints.S3_ENDPOINT.origin, SHORTS_PRIVATE_S3_ALLOW_LOOPBACK: '1', SHORTS_PRIVATE_S3_REGION: 'us-east-1', SHORTS_PRIVATE_S3_BUCKET: bucket,
    SHORTS_PRIVATE_S3_CREDENTIALS_FILE: join(dir, 's3.json'), SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE: join(dir, 'keys.json'),
    SHORTS_DEPLOYMENT_FILE: join(dir, 'deployment.json'), SHORTS_PUBLISHING_POLICY_FILE: join(dir, 'policy.json'),
    SHORTS_RATE_KEY_FILE: join(dir, 'rate.key'), SHORTS_SHARED_CONCURRENT_MEDIA: '1', SHORTS_TEST_SCHEMA: schema,
    SHORTS_IPFS_API: endpoints.KUBO_API.href, SHORTS_MODERATION_URL: `http://127.0.0.1:${scanner.address().port}`, SHORTS_MODERATION_TOKEN_FILE: join(dir, 'scanner.key'),
    ...(streamPort ? { SHORTS_STREAM_INTERNAL_URL: `http://127.0.0.1:${streamPort}`, SHORTS_STREAM_KEY_FILE: join(dir, 'stream.key') } : {}),
    REDIS_HOST: endpoints.REDIS_URL.hostname, REDIS_PORT: endpoints.REDIS_URL.port, TRUST_PROXY: 'false',
  });
  function child(file, extra, inherit = true) {
    const process = fork(join(__dirname, 'testing', file), [], { env: { ...(inherit ? env : {}), ...extra }, execArgv: compiled ? [] : ['-r','ts-node/register','-r','tsconfig-paths/register'], stdio: ['ignore','pipe','pipe','ipc'] });
    children.push(process); const messages = []; let output = '';
    process.on('message', value => {
      messages.push(value);
      if (['ready', 'started'].includes(value.type)) fixtureRuntimes.push({ fixture: file, ...value.runtime });
    }); for (const stream of [process.stdout, process.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-12000); });
    return { process, messages, async wait(type, id) { return until(() => {
      const found = messages.find(m => m.type === type && (!id || m.id === id)); if (found) {
        assert.equal(found.error, undefined);
        if (['ready', 'started'].includes(type)) assert.equal(found.runtime?.mode, compiled ? 'compiled' : 'typescript');
        return found;
      }
      if (process.exitCode !== null || process.signalCode !== null) throw new Error(`Fixture child exited: ${output}`); return false;
    }); }, async command(action, parameters = {}) { const id = randomUUID(); process.send({ ...parameters, action, id }); return this.wait('command', id); } };
  }
  await t.test('hosted startup works with a one-operation SQL budget and still rejects missing readiness', async () => {
    const single = child('hosted-runtime.cjs', { SHORTS_TEST_PG_URL: apiRole.url, SHORTS_DB_CONCURRENCY: '1' });
    await single.wait('ready'); single.process.send({ action: 'stop' }); await single.wait('stopped');
    if (single.process.exitCode === null && single.process.signalCode === null) await once(single.process, 'exit');
    await owner.query(`ALTER TABLE shorts_lifecycle_jobs DROP CONSTRAINT shorts_lifecycle_jobs_result_check,
      ADD CONSTRAINT shorts_lifecycle_jobs_result_check CHECK(result IN ('checked','publication_pending','retention_pending','reconciliation_required','failed'))`);
    const missing = child('hosted-runtime.cjs', { SHORTS_TEST_PG_URL: apiRole.url });
    await assert.rejects(missing.wait('ready'), /Apply the Shorts media-admission migration/);
    assert.equal(scans, 0);
    const { ShortsMediaAdmission1791763225000 } = require('../migrations/1791763225000-ShortsMediaAdmission');
    await new ShortsMediaAdmission1791763225000().up(owner);
  });
  const a = child('hosted-runtime.cjs', { SHORTS_TEST_PG_URL: apiRole.url }); a.base = (await a.wait('ready')).base;
  const b = child('hosted-runtime.cjs', { SHORTS_TEST_PG_URL: apiRole.url }); b.base = (await b.wait('ready')).base;
  async function request(api, path, body, token, timeout = 10000) {
    const response = await fetch(api.base + '/shorts' + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(timeout),
      headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    return { status: response.status, body: response.headers.get('Content-Type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }
  async function login(wallet) {
    const challenge = await request(a, '/auth/challenge', { address: wallet.address }); assert.equal(challenge.status, 201, JSON.stringify(challenge));
    const verified = await request(b, '/auth/verify', { id: challenge.body.id, signature: Buffer.from(await wallet.signMessage(challenge.body.message)).toString('hex') });
    assert.equal(verified.status, 201, JSON.stringify(verified)); return verified.body.token;
  }
  await t.test('public configuration serves the same release economics from either API process', async () => {
    for (const api of [a, b]) {
      const config = await request(api, '/config');
      assert.equal(config.status, 200);
      assert.equal(config.body.network, scope.network);
      assert.equal(config.body.contract, scope.contract);
      assert.equal(config.body.mode, 'testnet');
      assert.equal(config.body.likeFee, '0.1');
      assert.equal(config.body.creatorShare, 80);
      assert.equal(config.body.treasuryShare, 20);
      assert.equal(config.body.release.likeFeeAetto, '100000000000000000');
      assert.equal(config.body.release.treasuryBps, 2000);
      assert.equal(config.body.hosting, 'platform-funded');
    }
  });
  const creatorToken = await login(creator), operatorToken = await login(operator), outsiderToken = await login(AccountMemory.generate());
  const input = join(dir, 'input.mp4'); execFileSync('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=72x128:r=12','-t','2.2','-c:v','libx264','-pix_fmt','yuv420p',input]);
  const video = await readFile(input);
  const created = await request(a, '/uploads', { title: 'Owned fixture', topic: 'Art', rights: true, bytes: video.length, sha256: hash(video), details: { language: 'und' } }, creatorToken);
  assert.equal(created.status, 201, JSON.stringify(created)); const id = created.body.id;
  const form = new FormData(); form.append('file', new Blob([video]), 'part');
  assert.equal((await request(b, `/uploads/${id}/parts/0`, form, creatorToken)).status, 201);
  assert.equal((await request(a, `/uploads/${id}/finish`, {}, creatorToken)).status, 202);
  const workerEnv = { ...env, SHORTS_TEST_PG_URL: worker.url, SHORTS_TEST_UPLOAD_ID: id, SHORTS_WORKER_TMP_DIR: dir, SHORTS_WORKER_MAX_USED_PERCENT: '99' };
  delete workerEnv.SHORTS_IPFS_API; delete workerEnv.SHORTS_PUBLISHING_POLICY_FILE;
  delete workerEnv.SHORTS_STREAM_INTERNAL_URL; delete workerEnv.SHORTS_STREAM_KEY_FILE;
  // Child helper uses real FFmpeg/S3 and production worker wiring; safety there is an owned-fixture result.
  const w = child('media-worker.cjs', workerEnv, false); await w.wait('started');
  await until(async () => (await meta.getJob(scope, creator.address, id)).status === 'ready');
  w.process.kill('SIGTERM'); await once(w.process, 'exit');

  await t.test('real module providers share sessions and deny unauthorized private previews', async () => {
    assert.equal((await request(a, `/review-media/${id}`)).status, 401);
    assert.equal((await request(a, `/review-media/${id}`, undefined, outsiderToken)).status, 403);
    const preview = await request(b, `/review-media/${id}`, undefined, creatorToken); assert.equal(preview.status, 200); assert.ok(preview.body.length > 0);
    const status = await request(b, `/uploads/${id}`, undefined, creatorToken); assert.equal(status.status, 200); assert.equal(status.body.status, 'ready');
  });
  const pending = request(a, `/${id}/scan`, {}, creatorToken, 60000).catch(error => ({ error }));
  await until(() => scans === 1);
  await t.test('other process cannot read private media while the shared permit is occupied', async () => {
    const blocked = await request(b, `/review-media/${id}`, undefined, creatorToken); assert.equal(blocked.status, 503);
    assert.equal((await request(b, `/uploads/${id}`, undefined, creatorToken)).status, 200);
  });
  a.process.kill('SIGKILL'); await once(a.process, 'exit'); await pending;
  scannerMode = 'busy'; heldResponse?.destroy();
  redis = new Redis(endpoints.REDIS_URL.href);
  await until(async () => await redis.zcard(`shorts:media:v1:{${hash(`ae_uat:${scope.contract}`).slice(0,32)}}:active`) === 0 ||
    (await redis.zrangebyscore(`shorts:media:v1:{${hash(`ae_uat:${scope.contract}`).slice(0,32)}}:active`, Date.now(), '+inf')).length === 0);
  await owner.query('UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp(),lease_until=NULL');
  await b.command('reconcile');
  await t.test('scanner backpressure stays durable and a replacement process recovers the same upload', async () => {
    const [job] = await owner.query('SELECT result,attempts FROM shorts_lifecycle_jobs WHERE id=$1', [id]);
    assert.equal(job.result, 'capacity_wait'); assert.equal(job.attempts, 0);
    assert.equal((await meta.get(scope, id)).record.safety, undefined);
    scannerMode = 'ready'; await owner.query('UPDATE shorts_lifecycle_jobs SET next_at=clock_timestamp() WHERE id=$1', [id]);
    await b.command('reconcile'); assert.equal((await meta.get(scope, id)).record.safety.status, 'no_flags');
    c = child('hosted-runtime.cjs', { SHORTS_TEST_PG_URL: apiRole.url }); c.base = (await c.wait('ready')).base;
    assert.equal((await request(c, `/uploads/${id}`, undefined, creatorToken)).status, 200);
    assert.equal((await request(c, `/review/${id}`, { approved: true }, operatorToken)).status, 201);
    const publish = await request(c, `/${id}/publish`, {}, creatorToken); assert.equal(publish.status, 202, JSON.stringify(publish));
    await Promise.all([b.command('reconcile'), c.command('reconcile')]);
    const jobs = await owner.query('SELECT id,status FROM shorts_publication_jobs');
    assert.deepEqual(jobs.map(j => ({ ...j })), [{ id, status: 'queued' }]);
    assert.equal((await meta.uploadBudget(scope)).usedUploads, '1');
    const cid = (await meta.get(scope, id)).record.cid;
    const pinned = await fetch(endpoints.KUBO_API.href + '/pin/ls?arg=' + cid, { method: 'POST' }); assert.equal(pinned.status, 200);
    assert.equal((await request(c, `/${id}/publish`, {}, creatorToken)).status, 202);
    assert.equal(Number((await owner.query('SELECT count(*) AS count FROM shorts_publication_jobs'))[0].count), 1);
  });
  let uploaded;
  if (process.env.SHORTS_TEST_UPLOAD_LOAD === '1') await t.test(process.env.SHORTS_TEST_UPLOAD_MODE === 'concurrent'
    ? 'simultaneous varied uploads are processed by concurrent workers under the shared ceiling'
    : 'simultaneous varied uploads preserve private ownership and recover a killed worker under the shared ceiling', async () => {
    uploaded = await assembledUploadLoad(t, { owner, meta, scope, dir, b, c, request, until, pause,
      createWorker: paused => child('media-worker.cjs', { ...workerEnv, SHORTS_TEST_PAUSE_ENCODING: paused ? '1' : '0' }, false) });
  });
  if (process.env.SHORTS_TEST_MODERATION_URL) await t.test('actual model scans survive admission races and worker restart without publishing private uploads', async () => {
    await require('./testing/assembled-real-moderation.cjs').assembledRealModeration(t, { owner, meta, scope, dir, b, c, request, until, pause,
      createWorker: extra => child('media-worker.cjs', { ...workerEnv, ...extra }, false) });
  });
  await assembledIndex(t, { owner, admin, meta, scope, id, dir, creator, creatorToken, operator, operatorToken, b, c, request, until, pause, input, social, uploaded,
    async startUploadWorker() {
      const next = child('media-worker.cjs', workerEnv, false); await next.wait('started');
      return async () => { if (next.process.exitCode === null && next.process.signalCode === null) {
        next.process.kill('SIGTERM'); await once(next.process, 'exit');
      } };
    },
    mdwUrl: `http://127.0.0.1:${scanner.address().port}`, endpoints, streamPort, webPort });
  // Only this suite's package on its disposable offline node is unpinned.
  const cid = (await meta.get(scope, id)).record.cid;
  await fetch(endpoints.KUBO_API.href + '/pin/rm?arg=' + cid, { method: 'POST' });
  t.diagnostic(JSON.stringify({ fixtureRuntimes }));
});

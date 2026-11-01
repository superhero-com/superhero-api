const { releaseFixture } = require('./shorts-release.fixture.cjs');
// Opt-in, disposable Docker integration of the actual production entrypoint.
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, writeFile, readFile, readdir, rm, copyFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, isAbsolute } = require('node:path');
const { DataSource } = require('typeorm');
const { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const { ShortsMetadataService } = require('./shorts-metadata.service');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { Tx } = require('../mdw-sync/entities/tx.entity');
const { workerRole } = require('./testing/worker-role.cjs');
const run = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await read(); if (result) return result; await pause(200); }
  throw new Error('Container fixture condition did not become true');
}
const docker = async (...args) => (await run('docker', args, { timeout: 45000, maxBuffer: 1048576 })).stdout.trim();

test('production worker image preserves private jobs under its container limits', {
  skip: !process.env.SHORTS_TEST_WORKER_IMAGE, timeout: 420000,
}, async t => {
  assert.equal(process.env.SHORTS_TEST_WORKER_DISPOSABLE, '1');
  const image = process.env.SHORTS_TEST_WORKER_IMAGE;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const network = process.env.SHORTS_TEST_WORKER_NETWORK;
  assert.match(network, /^shorts-worker-container-[a-f0-9]{8}$/);
  const [net] = JSON.parse(await docker('network', 'inspect', network));
  assert.equal(net.Labels?.['superhero.disposable-worker-test'], 'true');
  const pg = new URL(process.env.SHORTS_TEST_PG_URL), s3 = new URL(process.env.SHORTS_TEST_S3_ENDPOINT);
  assert.equal(pg.hostname, '127.0.0.1'); assert.equal(s3.hostname, '127.0.0.1');
  for (const name of ['SHORTS_TEST_WORKER_CA_FILE', 'SHORTS_TEST_MODERATION_TOKEN_FILE']) assert.ok(isAbsolute(process.env[name]));
  const dir = await mkdtemp(join(tmpdir(), 'shorts-worker-container-'));
  const schema = `shorts_container_${randomUUID().replaceAll('-', '')}`;
  const volume = `shorts-worker-secrets-${randomUUID()}`, names = [], observations = [];
  const admin = await new DataSource({ type: 'postgres', url: pg.href }).initialize();
  let owner, identity, raw, bucket, objects;
  t.after(async () => {
    for (const name of names) await docker('rm', '-f', '-v', name).catch(() => {});
    await docker('volume', 'rm', volume).catch(() => {});
    objects?.onModuleDestroy();
    if (raw && bucket) {
      const list = await raw.send(new ListObjectsV2Command({ Bucket: bucket }));
      if (list.Contents?.length) await raw.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: list.Contents.map(o => ({ Key: o.Key })) } }));
      await raw.send(new DeleteBucketCommand({ Bucket: bucket })); raw.destroy();
    }
    if (owner?.isInitialized) await owner.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (identity) await identity.dispose(); await admin.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  owner = await new DataSource({ type: 'postgres', url: pg.href, schema, entities: [Tx], synchronize: true,
    extra: { options: `-c search_path=${schema}`, max: 4 } }).initialize();
  await owner.query('CREATE TABLE sync_state(id text PRIMARY KEY,tip_height integer,updated_at timestamptz); CREATE TABLE plugin_failed_transaction(plugin_name text,tx_hash text)');
  const migrations = (await readdir(join(__dirname, '../migrations'))).filter(name => /^\d+-Shorts.*\.ts$/.test(name)).sort();
  await owner.transaction(async db => {
    for (const file of migrations) { const Migration = Object.values(require('../migrations/' + file))[0]; await new Migration().up(db.queryRunner); }
  });
  const scope = { network: 'ae_uat', contract: releaseFixture().release.contract }, sourceHash = hash('owned container contract');
  const metadata = new ShortsMetadataService(owner); await metadata.initialize(scope, sourceHash);
  identity = await workerRole(admin, { url: pg.href, schema, scope });
  // The real DataSource uses the enrolled database role, without Nest overrides.
  await admin.query(`ALTER ROLE ${identity.role} SET search_path TO ${schema}`);
  const credentials = { accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY, secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY };
  const key = randomBytes(32); bucket = `shorts-container-${randomUUID()}`;
  raw = new S3Client({ endpoint: s3.origin, region: 'us-east-1', forcePathStyle: true, credentials, requestChecksumCalculation: 'WHEN_REQUIRED' });
  await raw.send(new CreateBucketCommand({ Bucket: bucket }));
  objects = new ShortsPrivateObjectsService({ endpoint: s3.origin, region: 'us-east-1', bucket, prefix: 'shorts-private-v1', forcePathStyle: true,
    credentials, activeKeyId: 'key1', keys: { key1: key } });
  for (const [name, value] of Object.entries({ 'deployment.json': JSON.stringify(releaseFixture({ ...scope, sourceHash }).release),
    'private-s3.json': JSON.stringify(credentials), 'private-keys.json': JSON.stringify({ activeKeyId: 'key1', keys: { key1: key.toString('hex') } }) }))
    await writeFile(join(dir, name), value, { mode: 0o600 });
  await copyFile(process.env.SHORTS_TEST_WORKER_CA_FILE, join(dir, 'fixture-ca.pem'));
  await copyFile(process.env.SHORTS_TEST_MODERATION_TOKEN_FILE, join(dir, 'moderation-token'));
  await docker('volume', 'create', '--label', `superhero.disposable-worker-network=${network}`, volume);
  await docker('run', '--rm', '--network=none', '--user=0:0', '--mount', `type=volume,src=${volume},dst=/run/secrets`,
    '--mount', `type=bind,src=${dir},dst=/seed,readonly`, image, 'sh', '-ec',
    'cp /seed/deployment.json /seed/private-s3.json /seed/private-keys.json /seed/fixture-ca.pem /seed/moderation-token /run/secrets/; chown -R 1000:1000 /run/secrets; chmod 700 /run/secrets; chmod 600 /run/secrets/*');
  const login = new URL(identity.url);
  const env = { NODE_ENV: 'production', DOTENV_CONFIG_PATH: '/dev/null', ENABLE_SHORTS: 'true', AE_NETWORK_ID: 'ae_uat', SHORTS_TESTNET_MVP: '1',
    SHORTS_DEMO_AUTO_APPROVE: '0', SHORTS_DEMO_CONNECTED_WALLET: '0', DB_TYPE: 'postgres', DB_HOST: 'database', DB_PORT: '5432',
    DB_DATABASE: decodeURIComponent(pg.pathname.slice(1)), DB_USER: login.username, DB_PASSWORD: login.password, DB_SYNC: 'false', DB_POOL_MAX: '5', DB_POOL_MIN: '1',
    SHORTS_DB_CONCURRENCY: '4', SHORTS_DEPLOYMENT_FILE: '/run/secrets/deployment.json', SHORTS_PRIVATE_S3_ENDPOINT: 'https://private-s3:8443',
    SHORTS_PRIVATE_S3_REGION: 'us-east-1', SHORTS_PRIVATE_S3_BUCKET: bucket, SHORTS_PRIVATE_S3_PATH_STYLE: 'true',
    SHORTS_PRIVATE_S3_CREDENTIALS_FILE: '/run/secrets/private-s3.json', SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE: '/run/secrets/private-keys.json',
    SHORTS_MODERATION_URL: 'https://moderation:8443', SHORTS_MODERATION_TOKEN_FILE: '/run/secrets/moderation-token', SHORTS_JEV_ENABLED: '0',
    SHORTS_WORKER_TMP_DIR: '/tmp', NODE_EXTRA_CA_CERTS: '/run/secrets/fixture-ca.pem' };
  async function state(name) { const [value] = JSON.parse(await docker('inspect', name)); return value.State; }
  async function start(extra = {}) {
    const name = `shorts-worker-image-${randomUUID()}`, envFile = join(dir, name + '.env'); names.push(name);
    await writeFile(envFile, Object.entries({ ...env, ...extra }).filter(([, value]) => value !== undefined).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    await docker('run', '--pull=never', '-d', '--name', name, '--label', `superhero.disposable-worker-network=${network}`, '--network', network, '--init', '--read-only', '--user=1000:1000',
      '--cpus=2', '--memory=1g', '--memory-swap=1g', '--pids-limit=96', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--log-opt=max-size=10m', '--log-opt=max-file=3', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m,uid=1000,gid=1000,mode=0700',
      '--mount', `type=volume,src=${volume},dst=/run/secrets,readonly`, '--env-file', envFile, image, 'node', 'dist/shorts/worker-main');
    return name;
  }
  async function healthy(name) {
    const value = await state(name);
    assert.equal(value.Running, true, (await docker('logs', name)).slice(-8000)); assert.equal(value.OOMKilled, false);
  }
  async function sample(name) {
    const result = JSON.parse(await docker('exec', name, 'node', '-e',
      "const fs=require('node:fs');process.stdout.write(JSON.stringify(Object.fromEntries(['memory.peak','memory.events','pids.peak','cpu.max'].map(k=>[k,fs.readFileSync('/sys/fs/cgroup/'+k,'utf8').trim()]))))"));
    observations.push(result); assert.match(result['memory.events'], /oom_kill 0/);
  }
  async function stop(name) {
    await docker('stop', '-t', '30', name); const value = await state(name);
    assert.equal(value.OOMKilled, false); assert.ok([0, 143].includes(value.ExitCode), `unexpected shutdown exit ${value.ExitCode}`);
  }
  async function enqueue(seconds, size, fps) {
    const id = randomUUID(), creator = 'ak_' + randomUUID().replaceAll('-', ''), file = join(dir, id + '.mp4');
    await run('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i',`testsrc2=s=${size}:r=${fps}:d=${seconds}`, '-c:v','libx264','-threads','2','-preset','ultrafast','-crf','32','-pix_fmt','yuv420p',file], { timeout: 60000 });
    const bytes = await readFile(file); assert.ok(bytes.length <= 40 * 1048576); const parts = [];
    for (let offset = 0, index = 0; offset < bytes.length; offset += 1048576, index++)
      parts.push({ index, object: await objects.put(scope, id, `source/${index}`, bytes.subarray(offset, offset + 1048576)) });
    const manifest = await objects.put(scope, id, 'manifest', Buffer.from(JSON.stringify({ version: 1, id, creator, sha256: hash(bytes), bytes: bytes.length, parts })));
    await metadata.enqueue(scope, id, creator, { objectKey: manifest.key, manifest, sha256: hash(bytes), bytes: bytes.length, title: 'Owned container clip', topic: 'Art', details: {} });
    return { id, creator, sha256: hash(bytes), seconds };
  }
  async function tlsProbe(trust) {
    return docker('run', '--rm', '--network', network, '--read-only', '--user=1000:1000', '--memory=128m', '--cap-drop=ALL',
      '--mount', `type=volume,src=${volume},dst=/run/secrets,readonly`, ...(trust ? ['-e', 'NODE_EXTRA_CA_CERTS=/run/secrets/fixture-ca.pem'] : []),
      image, 'node', '-e', "fetch('https://moderation:8443/health',{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok||!(await r.json()).ready)throw Error('not ready');console.log('ready')}).catch(e=>console.log(e.cause?.code||e.name))");
  }
  assert.equal(await tlsProbe(true), 'ready');
  assert.ok(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(await tlsProbe(false)));
  await t.test('production startup rejects signing credentials', async () => {
    const name = await start({ SHORTS_OPERATOR_KEY_FILE: '/forbidden/signer' });
    await until(async () => !(await state(name)).Running); assert.equal((await state(name)).ExitCode, 1);
    assert.equal(await metadata.workerCount(scope), 0);
  });
  const first = await enqueue(2, '3840x2160', 60);
  await t.test('untrusted TLS cannot claim a private upload', async () => {
    const name = await start({ NODE_EXTRA_CA_CERTS: undefined });
    await until(async () => await metadata.workerCount(scope) === 1); await pause(6500); await healthy(name);
    assert.equal((await metadata.getJob(scope, first.creator, first.id)).attempts, 0);
    await stop(name); assert.equal(await metadata.workerCount(scope), 0);
  });
  const worker = await start();
  async function ready(name, job, attempts) {
    await until(async () => { await healthy(name); const row = await metadata.getJob(scope, job.creator, job.id);
      assert.notEqual(row.status, 'failed'); return row.status === 'ready'; }, 210000);
    const row = await metadata.getJob(scope, job.creator, job.id), record = (await metadata.get(scope, job.id)).record;
    assert.equal(row.attempts, attempts); assert.equal(row.fence, String(attempts)); assert.equal(record.privateMedia.fence, String(attempts));
    assert.equal(record.safety.sourceSha256, job.sha256); assert.equal(record.safety.humanReviewRequired, true);
    assert.equal(record.safety.models.safety.repository, 'Falconsai/nsfw_image_detection'); assert.ok(record.safety.frameCount >= job.seconds * 2);
    assert.equal(record.publication, undefined); assert.notEqual(record.moderation, 'approved');
    const output = await objects.get(scope, record.privateMedia.files['video.mp4']), file = join(dir, job.id + '-output.mp4'); await writeFile(file, output);
    await run('ffmpeg', ['-nostdin','-v','error','-xerror','-i',file,'-f','null','-'], { timeout: 60000 });
    await sample(name);
  }
  await t.test('real production container scans and encodes accepted 4K input', async () => {
    await ready(worker, first, 1);
    const [config] = JSON.parse(await docker('inspect', worker));
    assert.equal(config.Config.User, '1000:1000'); assert.equal(config.HostConfig.ReadonlyRootfs, true);
    assert.equal(config.HostConfig.Memory, 1073741824); assert.equal(config.HostConfig.PidsLimit, 96); assert.equal(config.HostConfig.NanoCpus, 2000000000);
    assert.deepEqual(config.HostConfig.CapDrop, ['ALL']); assert.equal(Object.keys(config.HostConfig.PortBindings || {}).length, 0);
    assert.equal(await docker('exec', worker, 'sh', '-c', 'command -v g++ || command -v python3 || command -v make || command -v npm || command -v npx || command -v corepack || command -v yarn || true'), '');
  });
  await t.test('SIGTERM preserves work for normal-lease recovery in a replacement container', async () => {
    const job = await enqueue(60, '540x960', 12);
    await until(async () => (await metadata.getJob(scope, job.creator, job.id)).status === 'processing');
    await sample(worker); await stop(worker);
    assert.equal((await metadata.getJob(scope, job.creator, job.id)).status, 'processing');
    const replacement = await start(); await ready(replacement, job, 2); await stop(replacement);
    assert.equal(await metadata.workerCount(scope), 0);
    assert.equal(Number((await owner.query('SELECT count(*) AS n FROM shorts_publication_jobs'))[0].n), 0);
  });
  t.diagnostic(JSON.stringify({ workerImage: image, productionEntrypoint: 'dist/shorts/worker-main', observations }));
});

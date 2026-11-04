require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { mkdtemp, writeFile, chmod, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { ShortsPrivateObjectsService, privateObjectConfig } = require('./shorts-private-objects.service');
const scope = { network: 'ae_uat', contract: 'ct_privateStorageTest' };
const config = endpoint => ({ endpoint, region: 'us-east-1', bucket: 'private-shorts-tests', prefix: 'quarantine', forcePathStyle: true,
  credentials: { accessKeyId: 'test-only', secretAccessKey: 'not-a-real-credential' }, activeKeyId: 'key1', keys: { key1: randomBytes(32) } });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = new ShortsPrivateObjectsService(config(`http://127.0.0.1:${server.address().port}`));
  t.after(async () => { service.onModuleDestroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { service, server };
}

test('private object configuration requires explicit secure endpoints and owner-only secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-s3-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const credentials = join(dir, 'credentials.json'), keys = join(dir, 'keys.json');
  await writeFile(credentials, JSON.stringify({ accessKeyId: 'only-test', secretAccessKey: 'only-test-secret' }), { mode: 0o600 });
  await writeFile(keys, JSON.stringify({ activeKeyId: 'v1', keys: { v1: randomBytes(32).toString('hex') } }), { mode: 0o600 });
  const env = { SHORTS_PRIVATE_S3_ENDPOINT: 'https://private.example.com', SHORTS_PRIVATE_S3_REGION: 'us-east-1',
    SHORTS_PRIVATE_S3_BUCKET: 'private-shorts', SHORTS_PRIVATE_S3_CREDENTIALS_FILE: credentials, SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE: keys };
  const valid = await privateObjectConfig(env); assert.equal(valid.keys.v1.length, 32); assert.equal(valid.forcePathStyle, true);
  for (const endpoint of ['http://private.example.com', 'https://user:password@private.example.com', 'https://private.example.com/path', 'https://private.example.com/?x=1', 'http://127.0.0.1:9000'])
    await assert.rejects(privateObjectConfig({ ...env, SHORTS_PRIVATE_S3_ENDPOINT: endpoint }));
  const local = { ...env, SHORTS_PRIVATE_S3_ENDPOINT: 'http://127.0.0.1:9000', SHORTS_PRIVATE_S3_ALLOW_LOOPBACK: '1' };
  assert.equal((await privateObjectConfig(local)).endpoint, 'http://127.0.0.1:9000');
  await assert.rejects(privateObjectConfig({ ...local, NODE_ENV: 'production' }));
  await assert.rejects(privateObjectConfig({ ...env, SHORTS_PRIVATE_S3_PATH_STYLE: 'typo' }));
  await assert.rejects(privateObjectConfig({ ...env, SHORTS_PRIVATE_S3_PREFIX: '../outside' }));
  await assert.rejects(privateObjectConfig({ ...env, SHORTS_PRIVATE_S3_CREDENTIALS_FILE: '' }));
  await chmod(keys, 0o644); await assert.rejects(privateObjectConfig(env), /owner-only/); await chmod(keys, 0o600);
  await writeFile(credentials, '{"secretAccessKey":"do-not-log-this"');
  await assert.rejects(privateObjectConfig(env), error => !error.message.includes('do-not-log-this') && /secret JSON/.test(error.message));
});

test('private reads reject scope/size/path mistakes before making a request', async t => {
  const { service } = await fixture(t, () => assert.fail('Invalid reference reached network'));
  await assert.rejects(service.get(scope, { key: 'https://evil.test', bytes: 1, sha256: digest('a'), keyId: 'key1' }), { status: 400 });
  await assert.rejects(service.put(scope, '../escape', 'original', Buffer.from('a')), { status: 400 });
  await assert.rejects(service.put(scope, 'valid', '../source', Buffer.from('a')), { status: 400 });
  await assert.rejects(service.put(scope, 'valid', 'original', Buffer.alloc(0)), { status: 400 });
  await assert.rejects(service.put({ ...scope, network: 'unknown' }, 'valid', 'original', Buffer.from('a')), { status: 400 });
});

test('S3 requests do not follow redirects or leak provider error bodies', async t => {
  let forwarded = 0;
  const target = createServer((req, res) => { forwarded++; res.end('unexpected'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(async () => { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); });
  const { service } = await fixture(t, (req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/stolen` }); res.end('secret-provider-message');
  });
  await assert.rejects(service.put(scope, 'redirect', 'source', Buffer.from('a')), error => error.status === 503 && !error.message.includes('secret-provider-message'));
  assert.equal(forwarded, 0);
});

test('aborting a stalled private download closes its stream; invalid lengths fail closed', async t => {
  let encrypted;
  let malformed = false;
  const { service } = await fixture(t, async (req, res) => {
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); encrypted = Buffer.concat(chunks); res.end();
    } else {
      res.writeHead(200, { 'Content-Length': malformed ? '1000000000' : String(encrypted.length) });
      res.write(encrypted.subarray(0, 8)); // deliberately leave the body incomplete
    }
  });
  const ref = await service.put(scope, 'stalled', 'source', Buffer.from('sample'));
  const started = Date.now();
  await assert.rejects(service.get(scope, ref, AbortSignal.timeout(100)), { status: 503 });
  assert.ok(Date.now() - started < 2000);
  malformed = true;
  await assert.rejects(service.get(scope, ref), { status: 503 });
});

test('S3-compatible private objects: actual conditional writes, encryption, rotation and isolation', { skip: !process.env.SHORTS_TEST_S3_ENDPOINT, timeout: 45000 }, async t => {
  const endpoint = new URL(process.env.SHORTS_TEST_S3_ENDPOINT);
  assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Only disposable local storage is allowed in this test');
  const options = config(endpoint.origin);
  options.bucket = `shorts-test-${randomUUID()}`;
  options.credentials = { accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY, secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY };
  assert.ok(options.credentials.accessKeyId && options.credentials.secretAccessKey);
  const raw = new S3Client({ endpoint: options.endpoint, region: options.region, credentials: options.credentials, forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED' });
  await raw.send(new CreateBucketCommand({ Bucket: options.bucket }));
  const a = new ShortsPrivateObjectsService(options), b = new ShortsPrivateObjectsService(options);
  t.after(async () => {
    a.onModuleDestroy(); b.onModuleDestroy();
    const listed = await raw.send(new ListObjectsV2Command({ Bucket: options.bucket }));
    if (listed.Contents?.length) await raw.send(new DeleteObjectsCommand({ Bucket: options.bucket, Delete: { Objects: listed.Contents.map(row => ({ Key: row.Key })) } }));
    await raw.send(new DeleteBucketCommand({ Bucket: options.bucket })); raw.destroy();
  });
  const plaintext = Buffer.concat([Buffer.from('PRIVATE-UNREVIEWED-VIDEO'), randomBytes(1024 * 1024)]);
  const [one, two] = await Promise.all([a.put(scope, 'upload-a', 'part/0', plaintext), b.put(scope, 'upload-a', 'part/0', plaintext)]);
  assert.deepEqual(one, two);
  assert.deepEqual(await b.get(scope, one), plaintext);
  const stored = await raw.send(new GetObjectCommand({ Bucket: options.bucket, Key: one.key }));
  const encrypted = Buffer.from(await stored.Body.transformToByteArray());
  assert.equal(encrypted.length, plaintext.length + 36); assert.equal(encrypted.includes(Buffer.from('PRIVATE-UNREVIEWED-VIDEO')), false);
  assert.equal(stored.CacheControl, 'no-store'); assert.equal(stored.ContentType, 'application/octet-stream');
  await assert.rejects(raw.send(new PutObjectCommand({ Bucket: options.bucket, Key: one.key, Body: encrypted, IfNoneMatch: '*' })), error => error.$metadata.httpStatusCode === 412);
  await t.test('anonymous bucket access is denied', { skip: process.env.SHORTS_TEST_S3_EMULATOR === '1' ? 'Emulator does not enforce bucket authorization; verify against the deployment provider' : false }, async () => {
    const anonymous = await fetch(`${endpoint.origin}/${options.bucket}/${one.key}`);
    try { assert.equal(anonymous.status, 403); } finally { await anonymous.body?.cancel(); }
  });
  // Retrying with different bytes or a new lease attempt cannot overwrite an existing object.
  const different = await a.put(scope, 'upload-a', 'part/0', Buffer.from('replacement'));
  const attempt1 = await a.put(scope, 'upload-a', 'attempt/1/video', Buffer.from('first-attempt'));
  const attempt2 = await b.put(scope, 'upload-a', 'attempt/2/video', Buffer.from('new-attempt'));
  assert.notEqual(different.key, one.key); assert.notEqual(attempt1.key, attempt2.key);
  assert.deepEqual(await a.get(scope, one), plaintext);
  await assert.rejects(b.get({ ...scope, contract: 'ct_another' }, one), { status: 400 });
  await assert.rejects(b.get({ ...scope, network: 'ae_mainnet' }, one), { status: 400 });
  await assert.rejects(b.get(scope, { ...one, bytes: one.bytes - 1 }), { status: 503 });
  const rotated = new ShortsPrivateObjectsService({ ...options, activeKeyId: 'key2', keys: { ...options.keys, key2: randomBytes(32) } });
  t.after(() => rotated.onModuleDestroy());
  assert.deepEqual(await rotated.get(scope, one), plaintext);
  const fresh = await rotated.put(scope, 'upload-a', 'part/0', plaintext);
  assert.equal(fresh.keyId, 'key2'); assert.notEqual(fresh.key, one.key); await assert.rejects(a.get(scope, fresh), { status: 503 });
  // Authentic ciphertext cannot be transplanted into another upload, even with the same plaintext hash.
  const other = await a.put(scope, 'upload-b', 'part/0', plaintext);
  await raw.send(new PutObjectCommand({ Bucket: options.bucket, Key: other.key, Body: encrypted }));
  await assert.rejects(b.get(scope, other), { status: 503 });
  const corrupted = Buffer.from(encrypted); corrupted[corrupted.length - 1] ^= 1;
  await raw.send(new PutObjectCommand({ Bucket: options.bucket, Key: one.key, Body: corrupted }));
  await assert.rejects(a.get(scope, one), { status: 503 });
  await assert.rejects(a.put(scope, 'upload-a', 'part/0', plaintext), { status: 503 });
});

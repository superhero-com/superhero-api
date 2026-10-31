require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash, webcrypto } = require('node:crypto');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Readable } = require('node:stream');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { ShortsSourceService } = require('./shorts-source.service');
const { ShortsUploadInterceptor } = require('./shorts-upload.interceptor');
const scope = { network: 'ae_uat', contract: 'ct_directUploadTest' };
const digest = value => createHash('sha256').update(value).digest('hex');
const configuration = () => ({ endpoint: 'https://internal.example.com', uploadEndpoint: 'https://uploads.example.com',
  region: 'us-east-1', bucket: 'shorts-private', prefix: 'private', forcePathStyle: true,
  credentials: { accessKeyId: 'only-test', secretAccessKey: 'not-a-real-credential' },
  activeKeyId: 'v1', keys: { v1: randomBytes(32) } });

async function encrypt(plain, descriptor) {
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(descriptor.key, 'hex'), 'AES-GCM', false, ['encrypt']);
  const encrypted = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: Buffer.from(descriptor.iv, 'hex'),
    additionalData: Buffer.from(descriptor.aad, 'base64'), tagLength: 128 }, key, plain));
  return Buffer.concat([Buffer.from('SHPRIV02'), Buffer.from(descriptor.iv, 'hex'), encrypted.subarray(-16), encrypted.subarray(0, -16)]);
}

test('browser encryption decrypts only with the correct object key, scope, content and envelope', async t => {
  const config = configuration(), service = new ShortsPrivateObjectsService(config);
  t.after(() => service.onModuleDestroy());
  const plain = randomBytes(1024), iv = randomBytes(12).toString('hex');
  const ref = service.directReference(scope, 'one', 0, plain.length, digest(plain));
  const descriptor = service.directEncryption(scope, ref, iv);
  assert.notEqual(descriptor.key, config.keys.v1.toString('hex'));
  const other = service.directReference(scope, 'two', 0, plain.length, digest(plain));
  assert.notEqual(service.directEncryption(scope, other, iv).key, descriptor.key);
  let encrypted = await encrypt(plain, descriptor);
  service.client.send = async command => {
    assert.equal(command.constructor.name, 'GetObjectCommand');
    return { ContentLength: encrypted.length, Body: Readable.from([encrypted]) };
  };
  assert.deepEqual(await service.get(scope, ref), plain);
  await assert.rejects(service.get(scope, other), /could not be verified/);
  await assert.rejects(service.get({ ...scope, network: 'ae_mainnet' }, ref), { status: 400 });
  encrypted[encrypted.length - 1] ^= 1;
  await assert.rejects(service.get(scope, ref), /could not be verified/);
  encrypted = await encrypt(Buffer.alloc(plain.length), descriptor);
  await assert.rejects(service.get(scope, ref), /could not be verified/, 'plaintext SHA is checked by the worker');
});

test('presigned PUT binds size, checksum, create-only semantics and the public storage host', async t => {
  const service = new ShortsPrivateObjectsService(configuration());
  t.after(() => service.onModuleDestroy());
  const ref = service.directReference(scope, 'one', 0, 10, digest('plain'));
  service.client.send = async () => assert.fail('Signing must not fetch a video');
  const permission = await service.directUrl(scope, ref, digest('cipher'), Date.now() + 600000);
  const url = new URL(permission.url);
  assert.equal(url.origin, 'https://uploads.example.com');
  assert.equal(url.pathname, `/shorts-private/${ref.key}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  const signed = url.searchParams.get('X-Amz-SignedHeaders').split(';');
  for (const header of ['host', 'content-length', 'content-type', 'cache-control', 'if-none-match', 'x-amz-checksum-sha256']) assert.ok(signed.includes(header), header);
  assert.equal(permission.headers['if-none-match'], '*');
  assert.equal(permission.headers['x-amz-checksum-sha256'], Buffer.from(digest('cipher'), 'hex').toString('base64'));
  assert.equal(permission.headers.Authorization, undefined);
  assert.ok(Number(new URL((await service.directUrl(scope, ref, digest('cipher'), Date.now() + 10000)).url).searchParams.get('X-Amz-Expires')) <= 10);
  await assert.rejects(service.directUrl(scope, ref, digest('cipher'), Date.now() - 1));
});

test('completion uses HEAD only and refuses missing, wrong-size or wrong-checksum objects', async t => {
  const service = new ShortsPrivateObjectsService(configuration());
  t.after(() => service.onModuleDestroy());
  const ref = service.directReference(scope, 'one', 0, 10, digest('plain')), checksum = digest('cipher');
  let head = { ContentLength: 46, ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64') };
  service.client.send = async command => { assert.equal(command.constructor.name, 'HeadObjectCommand'); return head; };
  await service.verifyDirect(scope, ref, checksum);
  for (const invalid of [{ ...head, ContentLength: 47 }, { ContentLength: 46 }, { ...head, ChecksumSHA256: 'wrong' }]) {
    const saved = head; head = invalid;
    await assert.rejects(service.verifyDirect(scope, ref, checksum), { status: 400 }); head = saved;
  }
  service.client.send = async () => { throw new Error('secret-provider-error'); };
  await assert.rejects(service.verifyDirect(scope, ref, checksum), error => error.status === 400 && !error.message.includes('secret-provider'));
});

test('completion records a part only after storage verification and rejects another creator', async () => {
  const events = [], object = { key: 'owned' };
  const uploads = {
    get: async (_scope, _id, actor) => { if (actor !== 'ak_owner') throw new Error('Not found'); return { parts: [], directParts: { 0: { object, checksum: 'checksum' } } }; },
    part: async () => events.push('record'),
  };
  const source = new ShortsSourceService(uploads, { verifyDirect: async () => events.push('head') }, {});
  await source.completeDirect(scope, 'one', 'ak_owner', 0); assert.deepEqual(events, ['head', 'record']);
  await assert.rejects(source.completeDirect(scope, 'one', 'ak_other', 0));
  source.objects.verifyDirect = async () => { throw new Error('missing'); };
  await assert.rejects(source.completeDirect(scope, 'one', 'ak_owner', 0)); assert.equal(events.length, 2);
});

test('hosted binary endpoints reject before multipart parsing or buffer allocation', async () => {
  const interceptor = new ShortsUploadInterceptor({ shared: true, authenticate: async () => 'ak_owner' });
  for (const name of ['upload', 'uploadPart']) {
    const context = { getHandler: () => ({ name }), switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) };
    await assert.rejects(interceptor.intercept(context, { handle: () => assert.fail('Parser was invoked') }), { status: 400 });
  }
});

test('MinIO direct upload enforces signed size, checksum, create-only writes and anonymous denial', { skip: !process.env.SHORTS_TEST_S3_ENDPOINT, timeout: 60000 }, async t => {
  const endpoint = new URL(process.env.SHORTS_TEST_S3_ENDPOINT);
  assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Only an isolated loopback provider is permitted');
  const config = { ...configuration(), endpoint: endpoint.origin, uploadEndpoint: endpoint.origin,
    bucket: `shorts-direct-${randomUUID()}`, credentials: {
      accessKeyId: process.env.SHORTS_TEST_S3_ACCESS_KEY, secretAccessKey: process.env.SHORTS_TEST_S3_SECRET_KEY,
    } };
  const raw = new S3Client({ ...config, requestChecksumCalculation: 'WHEN_REQUIRED' });
  await raw.send(new CreateBucketCommand({ Bucket: config.bucket }));
  const service = new ShortsPrivateObjectsService(config);
  t.after(async () => {
    service.onModuleDestroy();
    const list = await raw.send(new ListObjectsV2Command({ Bucket: config.bucket }));
    if (list.Contents?.length) await raw.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: list.Contents.map(({ Key }) => ({ Key })) } }));
    await raw.send(new DeleteBucketCommand({ Bucket: config.bucket })); raw.destroy();
  });
  const plain = randomBytes(1024 * 1024), ref = service.directReference(scope, 'source', 0, plain.length, digest(plain));
  const body = await encrypt(plain, service.directEncryption(scope, ref, randomBytes(12).toString('hex')));
  const permission = await service.directUrl(scope, ref, digest(body), Date.now() + 60000);
  const send = (data = body, headers = permission.headers, url = permission.url) => fetch(url, { method: 'PUT', headers, body: data, redirect: 'error' });
  const consume = async response => { await response.arrayBuffer(); return response.status; };
  assert.equal(await consume(await send(body.subarray(1))), 403, 'signed length rejects another size');
  const corrupt = Buffer.from(body); corrupt[corrupt.length - 1] ^= 1;
  assert.equal(await consume(await send(corrupt)), 400, 'provider verifies ciphertext checksum');
  const unsigned = { ...permission.headers }; delete unsigned['if-none-match'];
  assert.ok([400, 403].includes(await consume(await send(body, unsigned))), 'create-only precondition cannot be removed');
  assert.equal(await consume(await send()), 200);
  await service.verifyDirect(scope, ref, digest(body));
  assert.deepEqual(await service.get(scope, ref), plain);
  assert.equal(await consume(await send()), 412, 'retry cannot replace the object');
  const anonymous = new URL(permission.url); anonymous.search = '';
  assert.equal(await consume(await fetch(anonymous)), 403);
  assert.equal(await consume(await send(body, permission.headers, anonymous.href)), 403);
  const preflight = await fetch(permission.url, { method: 'OPTIONS', headers: {
    Origin: 'https://superhero.stream', 'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'content-type,cache-control,if-none-match,x-amz-checksum-sha256',
  } });
  assert.ok(preflight.ok); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://superhero.stream');
  await preflight.arrayBuffer();
});

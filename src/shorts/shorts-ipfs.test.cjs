const { originalRecord } = require('./testing/original-record.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsMediaUnavailableError } = require('./shorts-media-admission.service');
const { createServer } = require('node:http');
const { once } = require('node:events');

function environment(t, values = {}) {
  const keys = ['SHORTS_IPFS_API', 'SHORTS_IPFS_TOKEN_FILE', 'SHORTS_IPFS_APIS', 'SHORTS_IPFS_CREDENTIALS_FILE', 'NODE_ENV'];
  const saved = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  }));
  keys.forEach(key => { delete process.env[key]; });
  Object.assign(process.env, values);
}

test('adaptive media reads verify bytes, fail on corruption and reload rotated keys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-ipfs-auth-'));
  t.after(() => rm(dir, { recursive: true }));
  const tokenFile = join(dir, 'token');
  environment(t, { SHORTS_IPFS_API: 'https://ipfs.example.com/api/v0', SHORTS_IPFS_TOKEN_FILE: tokenFile });
  const short = originalRecord(), bytes = Buffer.from('verified preview');
  Object.assign(short.files.find(file => file.name === 'video.mp4'), { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const media = new ShortsMediaService({});
  let token = 'a'.repeat(64), body = bytes;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.get('authorization'), `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    assert.equal(new URL(url).searchParams.get('arg'), short.derivatives.assetsCid + '/video.mp4');
    return new Response(body);
  });
  await writeFile(tokenFile, token);
  assert.deepEqual(await media.retrieve(short, 'video.mp4'), bytes);
  token = 'b'.repeat(64); await writeFile(tokenFile, token);
  body = Buffer.from('corrupt');
  await assert.rejects(media.retrieve(short, 'video.mp4'), /integrity/);
});

test('missing pins and failed unpins do not erase the cached inventory', async t => {
  environment(t);
  const media = new ShortsMediaService({});
  let fail = false;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('/pin/ls')) return new Response(JSON.stringify({ Keys: { known: {} } }));
    return new Response('{}', { status: fail ? 503 : 200 });
  });
  const pins = await media.pins();
  pins.clear();
  assert.equal(media.hasPin('known'), true, 'returned inventory cannot mutate internal state');
  assert.equal(media.hasPin('missing'), false);
  fail = true;
  await assert.rejects(media.unpin('known'), /remove IPFS pin/);
  assert.equal(media.hasPin('known'), true);
  fail = false;
  await media.unpin('known');
  assert.equal(media.hasPin('known'), false);
});

test('unsafe endpoints, missing keys and old multi-node config fail before network access', async t => {
  environment(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{}'); });
  for (const endpoint of [
    'http://storage.example.com/api/v0', 'https://storage.example.com/api/v0',
    'https://user:password@storage.example.com/api/v0',
    'http://127.0.0.1:35002/api/v0?token=bad', 'http://127.0.0.1:35002/api/v0#bad',
    'http://127.0.0.1:35002/api/v0,http://127.0.0.1:35003/api/v0',
  ]) {
    process.env.SHORTS_IPFS_API = endpoint;
    const media = new ShortsMediaService({});
    assert.equal(await media.health(), false);
    await assert.rejects(media.pins(), /IPFS/);
  }
  process.env.SHORTS_IPFS_API = 'http://127.0.0.1:35002/api/v0';
  process.env.NODE_ENV = 'production';
  await assert.rejects(new ShortsMediaService({}).onModuleInit(), /HTTPS/);
  delete process.env.NODE_ENV;
  for (const key of ['SHORTS_IPFS_APIS', 'SHORTS_IPFS_CREDENTIALS_FILE']) {
    process.env[key] = 'old-config';
    await assert.rejects(new ShortsMediaService({}).onModuleInit(), /Replace SHORTS_IPFS_APIS/);
    delete process.env[key];
  }
  process.env.SHORTS_IPFS_TOKEN_FILE = 'relative-token';
  await assert.rejects(new ShortsMediaService({}).pins(), /absolute path/);
  assert.equal(requests, 0);
});

test('malformed, missing and rejected keys never fall back to anonymous access', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shorts-ipfs-key-'));
  t.after(() => rm(dir, { recursive: true }));
  const tokenFile = join(dir, 'token');
  environment(t, { SHORTS_IPFS_API: 'https://ipfs.example.com/api/v0', SHORTS_IPFS_TOKEN_FILE: tokenFile });
  const media = new ShortsMediaService({});
  const request = t.mock.method(globalThis, 'fetch', async (_, options) => {
    assert.ok(options.headers.get('authorization'));
    return new Response('denied', { status: 403 });
  });
  await assert.rejects(media.pins(), /ENOENT/);
  await writeFile(tokenFile, 'invalid', { mode: 0o600 });
  await assert.rejects(media.pins(), /Invalid IPFS service token/);
  assert.equal(request.mock.callCount(), 0);
  await writeFile(tokenFile, 'a'.repeat(64));
  await assert.rejects(media.pins(), /inspect IPFS pins/);
  assert.equal(request.mock.callCount(), 1);
});

test('storage outage pauses reconciliation without unpinning or publishing anything', async () => {
  const { ShortsHostingService } = require('./shorts-hosting.service');
  const unexpected = () => assert.fail('storage outage must not change publication or pins');
  const worker = new ShortsHostingService({ serial: fn => fn(), read: unexpected }, {
    pins: async () => { throw new Error('storage unavailable'); }, unpin: unexpected, pin: unexpected,
  }, { publish: unexpected });
  await worker.reconcile();
});

test('real storage round trip uses one node and cleans up only its own test pin', { skip: !process.env.SHORTS_TEST_KUBO_API && process.env.SHORTS_IPFS_INTEGRATION !== '1' }, async t => {
  if (process.env.SHORTS_TEST_KUBO_API) {
    const endpoint = new URL(process.env.SHORTS_TEST_KUBO_API);
    assert.equal(endpoint.hostname, '127.0.0.1');
    environment(t, { SHORTS_IPFS_API: endpoint.href });
  }
  const media = new ShortsMediaService({});
  const bytes = Buffer.from(`shorts-storage-test-${randomUUID()}`);
  const dir = await mkdtemp(join(tmpdir(), 'shorts-original-'));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, 'source.mp4'); await writeFile(path, bytes);
  const file = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const { ShortsPackageService } = require('./shorts-package.service');
  const cid = await new ShortsPackageService().originalCid(file);
  t.after(async () => { await media.pins(); await media.unpin(cid); });
  assert.equal(await media.addFiles([{ ...file, name: 'source.mp4' }], false, new AbortController().signal, originalRecord(), cid, 'original'), cid);
  await media.verifyPinnedBytes(cid, undefined, file, new AbortController().signal);
  assert.ok((await media.pins()).has(cid));
});

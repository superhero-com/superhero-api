require('reflect-metadata');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { SHORTS_IPFS_IMPORT_QUERY } = require('./shorts-ipfs-import-profile');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, writeFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsSourceReaderService } = require('./shorts-source-reader.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { hashMediaFile, verifiedMediaBytes } = require('./shorts-media-file');
const hash = value => createHash('sha256').update(value).digest('hex');
const MiB = 1048576;
const scope = { network: 'ae_uat', contract: 'ct_fixture' };

test('100000000-byte originals use bounded parts and retain their identity after admission limits change', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-original-ceiling-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const block = Buffer.alloc(MiB, 37), bytes = 100000000, parts = [], expected = createHash('sha256');
  for (let offset = 0; offset < bytes; offset += MiB) {
    const data = block.subarray(0, Math.min(MiB, bytes - offset)); expected.update(data);
    parts.push({ index: parts.length, object: { key: `part-${parts.length}-${'a'.repeat(350)}`, keyId: 'key1', bytes: data.length, sha256: hash(data) } });
  }
  const sha256 = expected.digest('hex');
  const encoded = Buffer.from(JSON.stringify({ version: 1, id: 'large', creator: 'ak_fixture', bytes, sha256, parts }));
  assert.ok(encoded.length > 32768 && encoded.length < 98304);
  const manifest = { key: 'manifest', keyId: 'key1', bytes: encoded.length, sha256: hash(encoded) };
  let reads = 0, active = 0, peak = 0;
  const reader = new ShortsSourceReaderService({
    validateReference() {},
    async get(_scope, ref) {
      if (ref.key === 'manifest') return encoded;
      active++; peak = Math.max(peak, active); reads++;
      await new Promise(resolve => setImmediate(resolve)); active--;
      assert.ok(ref.bytes <= MiB); return block.subarray(0, ref.bytes);
    },
  });
  const job = { id: 'large', creator: 'ak_fixture', input: { objectKey: 'manifest', manifest, sha256, bytes, processingProfile: 'original-h264-v1', acceptedMaxBytes: bytes } };
  const path = join(directory, 'source');
  assert.deepEqual(await reader.readToFile(scope, job, path), { path, bytes, sha256 });
  assert.equal(reads, 96); assert.equal(peak, 1);
  assert.deepEqual(await hashMediaFile(path), { path, bytes, sha256 });
  await assert.rejects(reader.read(scope, job), /bounded file reader/);
  await assert.rejects(reader.manifestParts(scope, { ...job, input: { ...job.input, processingProfile: undefined } }), /accepted upload/);
  await assert.rejects(reader.manifestParts(scope, { ...job, input: { ...job.input, acceptedMaxBytes: bytes - 1 } }), /accepted upload/);
  assert.equal(reads, 96, 'invalid saved policies never fetch media parts');
});

async function fixture(t, size = 2 * MiB + 137) {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-original-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = Buffer.alloc(size, 37);
  original[original.length - 1] = 19;
  const parts = [];
  const bodies = new Map();
  for (let offset = 0; offset < size; offset += MiB) {
    const part = original.subarray(offset, offset + MiB);
    const object = { key: `part-${parts.length}`, bytes: part.length, sha256: hash(part), keyId: 'key1' };
    bodies.set(object.key, part); parts.push({ index: parts.length, object });
  }
  const data = Buffer.from(JSON.stringify({ version: 1, id: 'short1', creator: 'ak_fixture', bytes: size, sha256: hash(original), parts }));
  const manifest = { key: 'manifest', bytes: data.length, sha256: hash(data), keyId: 'key1' };
  bodies.set('manifest', data);
  let active = 0, maxActive = 0, calls = 0;
  const objects = {
    validateReference() {},
    async get(_scope, ref, signal) {
      signal?.throwIfAborted(); calls++; active++; maxActive = Math.max(active, maxActive);
      await new Promise(resolve => setImmediate(resolve));
      active--; return bodies.get(ref.key);
    },
  };
  const reader = new ShortsSourceReaderService(objects);
  const job = { id: 'short1', creator: 'ak_fixture', input: { processingProfile: 'original-h264-v1', objectKey: 'manifest', manifest, bytes: size, sha256: hash(original) } };
  return { directory, path: join(directory, 'original'), original, parts, bodies, objects, reader, job,
    counters: () => ({ active, maxActive, calls }) };
}

test('source file preserves all uploaded bytes and reads authenticated parts sequentially', async t => {
  const f = await fixture(t);
  const source = await f.reader.readToFile(scope, f.job, f.path);
  assert.deepEqual(source, { path: f.path, bytes: f.original.length, sha256: hash(f.original) });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(f.counters().maxActive, 1);
  assert.deepEqual(await hashMediaFile(f.path), source);
});

test('failed source verification removes partial scratch and does not overwrite existing files', async t => {
  const f = await fixture(t);
  f.bodies.set('part-1', Buffer.alloc(MiB, 99));
  await assert.rejects(f.reader.readToFile(scope, f.job, f.path), /part does not match/);
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
  await writeFile(f.path, 'another job');
  await assert.rejects(f.reader.readToFile(scope, f.job, f.path), { code: 'EEXIST' });
  assert.equal(await readFile(f.path, 'utf8'), 'another job');
});

test('cancellation stops further part reads and removes unauthenticated partial output', async t => {
  const f = await fixture(t);
  const cancel = new AbortController(), get = f.objects.get;
  f.objects.get = async (...args) => {
    const result = await get(...args);
    if (args[1].key === 'part-0') cancel.abort();
    return result;
  };
  await assert.rejects(f.reader.readToFile(scope, f.job, f.path, cancel.signal));
  assert.equal(f.counters().calls, 2);
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
});

test('a valid set of parts with a mismatched whole-source digest is rejected', async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(f.bodies.get('manifest'));
  manifest.sha256 = '0'.repeat(64); f.job.input.sha256 = manifest.sha256;
  f.bodies.set('manifest', Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(f.reader.readToFile(scope, f.job, f.path), /checksum does not match/);
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
});

test('original CID is stable across stream chunking and identifies the file rather than its directory', async t => {
  const f = await fixture(t), packages = new ShortsPackageService();
  const source = await f.reader.readToFile(scope, f.job, f.path);
  const cid = await packages.originalCid(source);
  async function* chunks() {
    for (let offset = 0; offset < f.original.length; offset += 17003)
      yield f.original.subarray(offset, offset + 17003);
  }
  assert.equal(await packages.originalStreamCid(chunks(), source), cid);
  assert.notEqual(await packages.cid([{ name: 'video.mp4', data: f.original }]), cid);
  f.original[0] ^= 1;
  assert.notEqual(await packages.originalStreamCid(chunks(), { ...source, sha256: hash(f.original) }), cid);
});

test('CID calculation rejects truncation, excess bytes, corruption and cancellation', async () => {
  const packages = new ShortsPackageService(), value = Buffer.from('unaltered original');
  const identity = { bytes: value.length, sha256: hash(value) };
  async function* input(bytes = value) { yield bytes; }
  for (const bytes of [value.subarray(1), Buffer.concat([value, value]), Buffer.alloc(value.length)])
    await assert.rejects(packages.originalStreamCid(input(bytes), identity));
  await assert.rejects(packages.originalStreamCid(input(), identity, AbortSignal.abort()));
  await assert.rejects(packages.originalStreamCid(input(), { ...identity, bytes: 100000001 }));
  const collect = async stream => { for await (const _ of stream) void _; };
  await assert.rejects(collect(verifiedMediaBytes(input(), { ...identity, sha256: 'invalid' })));
});

test('single-file CID matches offline Kubo at chunk and multi-block boundaries', { skip: !process.env.SHORTS_TEST_KUBO_API }, async () => {
  const endpoint = new URL(process.env.SHORTS_TEST_KUBO_API);
  assert.equal(endpoint.hostname, '127.0.0.1');
  const packages = new ShortsPackageService();
  for (const size of [5, 262144, 262145, 1048600]) {
    const data = Buffer.alloc(size, 42), form = new FormData();
    form.append('file', new Blob([data]), 'original.mov');
    const response = await fetch(`${endpoint.href}/add?wrap-with-directory=false&${SHORTS_IPFS_IMPORT_QUERY}&pin=false&only-hash=true`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    const expected = (await response.text()).trim().split('\n').map(JSON.parse).at(-1).Hash;
    async function* input() { yield data; }
    assert.equal(await packages.originalStreamCid(input(), { bytes: data.length, sha256: hash(data) }), expected);
  }
});


test('streamed original CIDs match Kubo across the file-tree boundary and contract ceiling',
  { skip: !process.env.SHORTS_TEST_KUBO_API, timeout: 120000 }, async () => {
    const endpoint = new URL(process.env.SHORTS_TEST_KUBO_API);
    assert.equal(endpoint.protocol, 'http:');
    assert.equal(endpoint.hostname, '127.0.0.1');
    const packages = new ShortsPackageService();
    async function* bytes(size) {
      for (let offset = 0, index = 0; offset < size; offset += 262144, index++) {
        const block = Buffer.alloc(Math.min(262144, size - offset), index % 251);
        if (block.length >= 4) block.writeUInt32BE(index);
        yield block;
      }
    }
    for (const size of [174 * 262144, 175 * 262144, 100000000]) {
      const digest = createHash('sha256');
      for await (const block of bytes(size)) digest.update(block);
      const expected = await packages.originalStreamCid(bytes(size), { bytes: size, sha256: digest.digest('hex') });
      const boundary = 'shorts-streamed-import-fixture';
      const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="original.mov"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      async function* multipart() { yield header; yield* bytes(size); yield footer; }
      const response = await fetch(`${endpoint.href}/add?${SHORTS_IPFS_IMPORT_QUERY}&wrap-with-directory=false&pin=false&only-hash=true`, {
        method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(header.length + size + footer.length) },
        body: Readable.from(multipart()), duplex: 'half', signal: AbortSignal.timeout(30000),
      });
      assert.equal(response.status, 200);
      const actual = (await response.text()).trim().split('\n').map(JSON.parse).at(-1).Hash;
      assert.equal(actual, expected, `${size}-byte file CID`);
    }
  });

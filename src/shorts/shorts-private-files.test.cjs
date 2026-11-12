require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { mkdtemp, writeFile, readFile, readdir, rm, stat } = require('node:fs/promises');
const { Readable } = require('node:stream');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { ShortsPrivateObjectsService } = require('./shorts-private-objects.service');
const { hashMediaFile } = require('./shorts-media-file');
const scope = { network: 'ae_uat', contract: 'ct_fileFixture' };
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-private-files-'));
  const service = new ShortsPrivateObjectsService({ endpoint: 'http://127.0.0.1:9', region: 'us-east-1', bucket: 'local-test', prefix: 'quarantine', forcePathStyle: true,
    credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' }, activeKeyId: 'key1', keys: { key1: randomBytes(32) } });
  t.after(async () => { service.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  const objects = new Map();
  let writes = 0;
  service.client.send = async (command, options) => {
    options?.abortSignal?.throwIfAborted();
    const input = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      writes++;
      if (objects.has(input.Key)) throw { $metadata: { httpStatusCode: 412 } };
      const chunks = [];
      if (Buffer.isBuffer(input.Body)) chunks.push(input.Body);
      else {
        assert.ok(input.Body instanceof Readable, 'file uploads must stream instead of buffering the entire envelope');
        for await (const chunk of input.Body) chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      assert.equal(data.length, input.ContentLength);
      assert.equal(createHash('sha256').update(data).digest('base64'), input.ChecksumSHA256);
      objects.set(input.Key, data); return {};
    }
    assert.equal(command.constructor.name, 'GetObjectCommand');
    const data = objects.get(input.Key);
    assert.ok(data);
    async function* chunks() {
      // Deliberately split the authenticated header across network frames.
      for (let offset = 0; offset < data.length; offset += offset < 40 ? 3 : 17003)
        yield data.subarray(offset, offset + (offset < 40 ? 3 : 17003));
    }
    return { ContentLength: data.length, Body: Readable.from(chunks()) };
  };
  const path = join(directory, 'input');
  const bytes = randomBytes(2 * 1048576 + 37);
  await writeFile(path, bytes);
  return { directory, service, objects, bytes, source: await hashMediaFile(path), writes: () => writes };
}

test('streamed encryption is compatible with existing reads and retries verify the stored object', async t => {
  const f = await fixture(t);
  const ref = await f.service.putFile(scope, 'job', 'attempt/1/video-1080-mp4', f.source, f.directory);
  assert.equal(ref.sha256, hash(f.bytes));
  assert.deepEqual(await f.service.get(scope, ref), f.bytes);
  const output = join(f.directory, 'restored');
  assert.deepEqual(await f.service.getToFile(scope, ref, output), { path: output, bytes: f.source.bytes, sha256: f.source.sha256 });
  assert.deepEqual(await readFile(output), f.bytes);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(await f.service.putFile(scope, 'job', 'attempt/1/video-1080-mp4', f.source, f.directory), ref);
  assert.equal(f.writes(), 2);
  assert.deepEqual((await readdir(f.directory)).sort(), ['input', 'restored']);
});

test('tampered ciphertext never becomes a verified scratch result or successful retry', async t => {
  const f = await fixture(t);
  const ref = await f.service.putFile(scope, 'job', 'attempt/1/video-1080-mp4', f.source, f.directory);
  f.objects.get(ref.key)[100] ^= 1;
  const path = join(f.directory, 'invalid');
  await assert.rejects(f.service.getToFile(scope, ref, path), { status: 503 });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await assert.rejects(f.service.putFile(scope, 'job', 'attempt/1/video-1080-mp4', f.source, f.directory), { status: 503 });
  assert.deepEqual(await readdir(f.directory), ['input']);
});

test('file storage rejects changed source identities and does not clobber existing scratch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.putFile(scope, 'job', 'attempt/1/video-1080-mp4', { ...f.source, sha256: '0'.repeat(64) }, f.directory), /integrity mismatch/);
  assert.equal(f.writes(), 0);
  const ref = await f.service.putFile(scope, 'job', 'attempt/1/video-1080-mp4', f.source, f.directory);
  await assert.rejects(f.service.getToFile(scope, ref, f.source.path), { code: 'EEXIST' });
  assert.deepEqual(await readFile(f.source.path), f.bytes);
  await assert.rejects(f.service.putFile(scope, 'job', 'attempt/1/video-1080-mp4', f.source, f.directory, AbortSignal.abort()));
  assert.deepEqual(await readdir(f.directory), ['input']);
});

test('streamed reads also accept the existing buffered encryption format', async t => {
  const f = await fixture(t);
  const ref = await f.service.put(scope, 'job', 'part/0', f.bytes);
  const path = join(f.directory, 'legacy');
  await f.service.getToFile(scope, ref, path);
  assert.deepEqual(await readFile(path), f.bytes);
});

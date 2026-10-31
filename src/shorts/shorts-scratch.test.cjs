require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readdir, statfs } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { ShortsScratchService, ShortsScratchProbeService, ScratchCapacityError } = require('./shorts-scratch.service');
const MiB = 1048576;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sample = (overrides = {}) => ({ type: 1n, bsize: 4096n, blocks: 262144n, bfree: 131072n, bavail: 131072n, files: 10000n, ffree: 5000n, ...overrides });
function fixture(t, overrides = {}, initial = sample()) {
  let value = initial;
  const config = { directory: '/fixture', minFreeBytes: 64 * MiB, minFreeInodes: 128, maxUsedPercent: 85, ...overrides };
  const disk = new ShortsScratchService(config, { read: async () => { if (value instanceof Error) throw value; return value; } });
  t.after(() => disk.onModuleDestroy());
  return { config, disk, set: next => { value = next; } };
}

test('actual filesystem observations use exact bigint bytes and inodes without writing files', async t => {
  const path = await mkdtemp(join(tmpdir(), 'disk-probe-')); t.after(() => rm(path, { force: true, recursive: true }));
  const result = await new ShortsScratchProbeService().read(path), direct = await statfs(path, { bigint: true });
  assert.equal(result.blocks, direct.blocks); assert.equal(result.bsize, direct.bsize); assert.ok(result.files > 0n);
  assert.deepEqual(await readdir(path), []);
});

test('byte and inode floors reject before reservation; unknown or invalid samples fail closed', async t => {
  const f = fixture(t);
  for (const value of [sample({ bavail: 0n }), sample({ ffree: 127n }), sample({ bavail: 39000n }), sample({ ffree: 1499n }),
    sample({ bsize: 0n }), sample({ bavail: -1n }), sample({ bavail: 300000n }), sample({ files: 0n }),
    sample({ ffree: 10001n }), sample({ blocks: Number.MAX_SAFE_INTEGER }), new Error('private mount path')]) {
    f.set(value); await assert.rejects(f.disk.reserve(1024, 1), { status: 503 });
    assert.equal((await f.disk.snapshot()).admissionOpen, false);
  }
  f.set(sample()); const lease = await f.disk.reserve(1024, 1); lease.release();
  assert.equal((await f.disk.snapshot()).reservations, 0);
});

test('concurrent reservations serialize, retain allocation slack and release idempotently', async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([f.disk.reserve(200 * MiB, 40), f.disk.reserve(200 * MiB, 40)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 503);
  const lease = results.find(r => r.status === 'fulfilled').value;
  const stats = await f.disk.snapshot(); assert.equal(stats.reservedBytes, String(200 * MiB + 40 * 4096));
  lease.release(); lease.release();
  const next = await f.disk.reserve(200 * MiB, 40); next.release();
  assert.equal((await f.disk.snapshot()).reservedInodes, '0');
});

test('pressure during work cancels leases, preserves reservations until cleanup and recovers', async t => {
  const f = fixture(t), lease = await f.disk.reserve(1024, 2);
  f.set(sample({ bavail: 1n }));
  await Promise.race([new Promise(resolve => lease.signal.addEventListener('abort', resolve, { once: true })),
    sleep(1500).then(() => { throw Error('Disk monitor did not cancel'); })]);
  assert.ok(lease.signal.reason instanceof ScratchCapacityError);
  assert.equal((await f.disk.snapshot()).reservations, 1);
  lease.release(); f.set(sample());
  const next = await f.disk.reserve(1024, 2); assert.equal(next.signal.aborted, false); next.release();
});

test('a stalled filesystem probe stays single-flight after timeout and does not authorize work', async t => {
  let calls = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const config = fixture(t).config;
  const disk = new ShortsScratchService(config, { read: () => { calls++; return held; } });
  t.after(() => disk.onModuleDestroy());
  const start = Date.now(); await assert.rejects(disk.reserve(1024, 1), { status: 503 });
  assert.ok(Date.now() - start < 1500);
  assert.equal((await disk.snapshot()).observed, false); assert.equal(calls, 1);
  release(sample()); await sleep(1);
  const lease = await disk.reserve(1024, 1); lease.release(); assert.equal(calls, 2);
});

test('shutdown and cancelled admission cannot acquire new reservations', async t => {
  const f = fixture(t), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.disk.reserve(1024, 1, cancelled.signal));
  const lease = await f.disk.reserve(1024, 1); f.disk.onModuleDestroy();
  assert.equal(lease.signal.aborted, true);
  await assert.rejects(f.disk.reserve(1024, 1), { status: 503 }); lease.release();
});

test('a decoder failure during a sudden space loss is deferred even before the periodic monitor observes it', async t => {
  const { ShortsEncodingService } = require('./shorts-encoding.service');
  const directory = await mkdtemp(join(tmpdir(), 'scratch-fast-failure-'));
  let reads = 0;
  const scratch = new ShortsScratchService({ ...fixture(t).config, directory }, {
    read: async () => ++reads === 1 ? sample() : sample({ bavail: 0n }),
  });
  t.after(async () => { scratch.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(new ShortsEncodingService(scratch).encode(Buffer.from('invalid fixture'), 'Clip', 'Art'),
    error => error instanceof ScratchCapacityError);
  assert.ok(reads >= 2); assert.deepEqual(await readdir(directory), []);
  assert.equal((await scratch.snapshot()).reservations, 0);
});

test('encoder refuses scratch pressure before creating files, and cancels active FFmpeg with cleanup', { timeout: 15000 }, async t => {
  const { execFileSync } = require('node:child_process');
  const { readFile } = require('node:fs/promises');
  const { ShortsEncodingService } = require('./shorts-encoding.service');
  const sourceDir = await mkdtemp(join(tmpdir(), 'scratch-source-'));
  const workDir = await mkdtemp(join(tmpdir(), 'scratch-work-'));
  t.after(async () => { await rm(sourceDir, { recursive: true, force: true }); await rm(workDir, { recursive: true, force: true }); });
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=128x128:r=10:d=60', '-c:v', 'libx264', '-threads', '1', join(sourceDir, 'owned.mp4')]);
  const bytes = await readFile(join(sourceDir, 'owned.mp4'));
  const f = fixture(t, { directory: workDir }, sample({ ffree: 0n }));
  const encoder = new ShortsEncodingService(f.disk);
  await assert.rejects(encoder.encode(bytes, 'Owned test clip', 'Art'), { status: 503 });
  assert.deepEqual(await readdir(workDir), []);
  f.set(sample());
  const started = encoder.encode(bytes, 'Owned test clip', 'Art');
  const rejected = assert.rejects(started, error => error instanceof ScratchCapacityError);
  for (let i = 0; i < 100; i++) { if ((await readdir(workDir)).length) break; await sleep(10); }
  assert.equal((await readdir(workDir)).length, 1);
  f.set(sample({ bavail: 1n }));
  await Promise.race([rejected, sleep(3000).then(() => { throw Error('Encoder was not cancelled'); })]);
  assert.deepEqual(await readdir(workDir), []);
  assert.equal((await f.disk.snapshot()).reservations, 0);
  f.set(sample()); await f.disk.check(); assert.equal((await f.disk.snapshot()).reservations, 0);
});

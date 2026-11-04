require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsPrivateMediaService } = require('./shorts-private-media.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { ShortsScratchService, ShortsScratchProbeService } = require('./shorts-scratch.service');
const { hashMediaFile } = require('./shorts-media-file');
const { derivedFiles } = require('./shorts-original-content');
const scope = { network: 'ae_uat', contract: 'ct_originalMedia' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-original-media-'));
  const maxUsedPercent = Number(process.env.SHORTS_TEST_SCRATCH_MAX_USED_PERCENT || 85);
  assert.ok(Number.isInteger(maxUsedPercent) && maxUsedPercent >= 50 && maxUsedPercent <= 99);
  const scratch = new ShortsScratchService({ directory: join(directory, 'scratch'), minFreeBytes: 64 * 1048576, minFreeInodes: 128, maxUsedPercent }, new ShortsScratchProbeService());
  await scratch.onModuleInit();
  t.after(async () => { scratch.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  const original = Buffer.alloc(1048600, 37), originalPath = join(directory, 'original');
  await writeFile(originalPath, original);
  const source = await hashMediaFile(originalPath), packages = new ShortsPackageService();
  const files = [], data = new Map();
  for (const name of ['video-1080.mp4', 'video-rescue.mp4', 'video.mp4', 'poster.jpg', 'manifest.json']) {
    const path = join(directory, name), bytes = Buffer.from('owned bytes for ' + name);
    await writeFile(path, bytes); files.push({ ...await hashMediaFile(path), name }); data.set(name, bytes);
  }
  const short = {
    id: 'source', creator: 'ak_creator', cid: await packages.originalCid(source), bytes: source.bytes,
    original: { version: 1, sha256: source.sha256, mediaType: 'video/quicktime', importProfile: 'unixfs-file-v1-262144' },
    derivatives: { version: 1, cid: await packages.derivativeCid(derivedFiles(files, 'inputs'), 'inputs'),
      assetsCid: await packages.derivativeCid(derivedFiles(files, 'assets'), 'assets'),
      profile: 'original-h264-v1', fingerprint: 'a'.repeat(64), generation: { job: 'source', fence: '1' },
      videos: [{ name: 'video-1080.mp4', width: 320, height: 180, frameRate: '60/1' }, { name: 'video-rescue.mp4', width: 256, height: 144, frameRate: '15/1' }] },
    files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    privateMedia: { version: 1, fence: '1', source: { processingProfile: 'original-h264-v1', bytes: source.bytes, sha256: source.sha256 },
      files: Object.fromEntries(files.map(file => [file.name, { key: file.name, bytes: file.bytes, sha256: file.sha256 }])) },
  };
  const privateMedia = new ShortsPrivateMediaService({
    get: async (_scope, ref) => Buffer.from(data.get(ref.key)),
    getToFile: async (_scope, ref, path) => { await writeFile(path, data.get(ref.key), { flag: 'wx', mode: 0o600 }); return hashMediaFile(path); },
  }, {
    readToFile: async (_scope, _job, path) => { await writeFile(path, original, { flag: 'wx', mode: 0o600 }); return hashMediaFile(path); },
  }, scratch);
  let active = 0, acquisitions = 0;
  const media = new ShortsMediaService({ scan: async file => {
    assert.deepEqual(await readFile(file.path), original); return { status: 'no_flags', sourceSha256: file.sha256 };
  } }, privateMedia, { shared: true, chain: { release: scope, state: { contract: scope.contract } } }, undefined, {
    acquire: async () => { active++; acquisitions++; return { signal: new AbortController().signal, release: async () => { active--; } }; },
  }, scratch);
  t.after(() => media.onModuleDestroy());
  const pins = new Map(), calls = [], adds = [];
  media.ipfsFetch = async (path, request) => {
    request.signal.throwIfAborted(); calls.push(path);
    const url = new URL('http://fixture/' + path), arg = url.searchParams.get('arg');
    if (url.pathname === '/pin/ls') return pins.has(arg)
      ? Response.json({ Keys: { [arg]: { Type: 'recursive' } } })
      : Response.json({ Code: 0, Message: `path '${arg}' is not pinned` }, { status: 500 });
    if (url.pathname === '/add') {
      const directory = url.searchParams.get('wrap-with-directory') === 'true';
      assert.equal(url.searchParams.get('chunker'), 'size-262144');
      assert.equal(url.searchParams.get('raw-leaves'), 'true');
      assert.equal(url.searchParams.get('hash'), 'sha2-256');
      assert.equal(url.searchParams.get('max-file-links'), '174');
      assert.equal(url.searchParams.get('trickle'), 'false');
      assert.equal(url.searchParams.get('max-directory-links'), '0');
      assert.equal(url.searchParams.get('max-hamt-fanout'), '256');
      const values = new Map();
      for (const [key, file] of request.body.entries()) {
        assert.equal(key, 'file'); values.set(file.name, Buffer.from(await file.arrayBuffer()));
      }
      const kind = values.has('poster.jpg') ? 'assets' : 'inputs';
      const cid = directory ? kind === 'assets' ? short.derivatives.assetsCid : short.derivatives.cid : short.cid;
      if (!directory) { assert.equal(values.size, 1); assert.deepEqual(values.get('original.mp4'), original); }
      else assert.deepEqual(values, new Map(derivedFiles(files, kind).map(file => [file.name, data.get(file.name)])));
      pins.set(cid, directory ? values : values.get('original.mp4')); adds.push({ directory, cid });
      return new Response(JSON.stringify({ Hash: cid }) + '\n');
    }
    assert.equal(url.pathname, '/cat');
    const [cid, name] = arg.split('/'), stored = pins.get(cid);
    const bytes = stored instanceof Map ? stored.get(name) : stored;
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  };
  return { short, media, pins, adds, calls, scratch, files, packages, active: () => active, acquisitions: () => acquisitions };
}

test('publication pins the original, durable assets and temporary inputs separately, with verified retries', async t => {
  const f = await fixture(t);
  await f.media.ensurePinned(f.short);
  assert.deepEqual(f.adds, [{ directory: false, cid: f.short.cid }, { directory: true, cid: f.short.derivatives.assetsCid }, { directory: true, cid: f.short.derivatives.cid }]);
  assert.equal(f.media.hasPin(f.short.cid), true); assert.equal(f.media.hasPin(f.short.derivatives.cid), true);
  assert.ok(f.calls.includes('cat?arg=' + f.short.cid));
  assert.equal(f.calls.some(path => path.includes(encodeURIComponent(f.short.cid + '/'))), false);
  await f.media.ensurePinned(f.short); assert.equal(f.adds.length, 3);
  assert.equal(f.media.hasPin(f.short.derivatives.assetsCid), true);
  assert.deepEqual([...f.pins.get(f.short.derivatives.assetsCid).keys()], ['video.mp4', 'poster.jpg', 'manifest.json']);
  assert.deepEqual([...f.pins.get(f.short.derivatives.cid).keys()], ['video-1080.mp4', 'video-rescue.mp4']);
  assert.deepEqual(await f.media.retrieve(f.short, 'poster.jpg'), f.pins.get(f.short.derivatives.assetsCid).get('poster.jpg'));
  assert.equal((await f.media.rescan(f.short)).sourceSha256, f.short.original.sha256);
  assert.equal(f.active(), 0); assert.equal(f.acquisitions(), 4);
  assert.deepEqual(await readdir(f.scratch.directory), []);
  assert.equal((await f.scratch.snapshot()).reservations, 0);
});

test('durable pin repair restores source and assets without reading or restoring retired encoded inputs', async t => {
  const f = await fixture(t); await f.media.ensurePinned(f.short);
  f.pins.delete(f.short.derivatives.cid); f.pins.delete(f.short.cid); f.pins.delete(f.short.derivatives.assetsCid);
  f.calls.length=0; f.adds.length=0;
  await f.media.restoreDurablePins(f.short);
  assert.deepEqual(f.adds,[{directory:false,cid:f.short.cid},{directory:true,cid:f.short.derivatives.assetsCid}]);
  assert.equal(f.calls.some(path=>decodeURIComponent(path).includes(f.short.derivatives.cid)),false);
  assert.equal(f.pins.has(f.short.derivatives.cid),false);
  assert.deepEqual(await f.media.retrieve(f.short,'poster.jpg'),Buffer.from('owned bytes for poster.jpg'));
  assert.equal(f.active(),0); assert.deepEqual(await readdir(f.scratch.directory),[]);
});

test('published and withdrawn originals support moderation and review after processing storage is gone', async t => {
  const f = await fixture(t); await f.media.ensurePinned(f.short);
  f.pins.delete(f.short.derivatives.cid);
  f.media.privateMedia = {
    withOriginal: () => assert.fail('published inspection must not read retired staging'),
    file: () => assert.fail('published review must not read retired staging'),
  };
  const additions = f.adds.length;
  for (const publication of ['published', 'withdrawn']) {
    f.short.publication = publication;
    f.short.moderation = 'pending'; f.short.safety = undefined;
    const before = structuredClone(f.short), acquisitions = f.acquisitions();
    // Moderation may already be pending/blocked when a rescan is requested.
    assert.equal((await f.media.rescan(f.short)).sourceSha256, f.short.original.sha256);
    assert.deepEqual(await f.media.preview(f.short), Buffer.from('owned bytes for video.mp4'));
    assert.equal(f.acquisitions(), acquisitions + 2, 'one admission per operation');
    assert.equal(f.active(), 0); assert.deepEqual(f.short, before);
    assert.deepEqual(await readdir(f.scratch.directory), []);
    assert.equal((await f.scratch.snapshot()).reservations, 0);
  }
  assert.equal(f.adds.length, additions, 'review must not republish processing inputs');
  assert.equal(f.pins.has(f.short.derivatives.cid), false);
  f.pins.get(f.short.derivatives.assetsCid).get('video.mp4')[0] ^= 1;
  await assert.rejects(f.media.preview(f.short), /integrity check failed/);
  assert.equal(f.active(), 0);
});

test('pending original inspection and review keep using private storage before publication', async t => {
  const f = await fixture(t);
  f.media.ipfsFetch = () => assert.fail('unpublished source must not require an IPFS pin');
  for (const publication of [undefined, 'pending']) {
    f.short.publication = publication;
    assert.equal((await f.media.rescan(f.short)).sourceSha256, f.short.original.sha256);
    assert.deepEqual(await f.media.preview(f.short), Buffer.from('owned bytes for video.mp4'));
  }
  assert.equal(f.acquisitions(), 4); assert.equal(f.active(), 0);
  assert.deepEqual(await readdir(f.scratch.directory), []);
});

test('published original inspection rejects lost pins, corrupt bytes and wrong CIDs without staging fallback', async t => {
  const f = await fixture(t); await f.media.ensurePinned(f.short); f.short.publication = 'published';
  let scans = 0;
  f.media.safety.scan = async () => { scans++; assert.fail('unverified source reached moderation'); };
  f.media.privateMedia.withOriginal = () => assert.fail('cannot replace a missing or corrupt canonical source with staging');
  const bytes = Buffer.from(f.pins.get(f.short.cid)), cid = f.short.cid;
  f.pins.delete(cid);
  await assert.rejects(f.media.rescan(f.short), /not recursively pinned/);
  f.pins.set(cid, Buffer.alloc(bytes.length));
  await assert.rejects(f.media.rescan(f.short), /integrity mismatch/);
  f.pins.set(cid, bytes.subarray(1));
  await assert.rejects(f.media.rescan(f.short), /integrity mismatch/);
  const wrongCid = require('./testing/hls-v3.json').descriptor.cid;
  f.short.cid = wrongCid; f.pins.set(wrongCid, bytes);
  await assert.rejects(f.media.rescan(f.short), /CID mismatch/);
  f.short.cid = cid; f.pins.set(cid, bytes);
  const fetch = f.media.ipfsFetch;
  f.media.ipfsFetch = async (path, request) => {
    const result = await fetch(path, request);
    if (path === `cat?arg=${cid}`) f.pins.delete(cid);
    return result;
  };
  await assert.rejects(f.media.rescan(f.short), /pin changed/);
  f.media.ipfsFetch = fetch; f.pins.set(cid, bytes);
  await assert.rejects(f.media.rescan(f.short, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(scans, 0); assert.equal(f.active(), 0);
  assert.deepEqual(await readdir(f.scratch.directory), []);
  assert.equal((await f.scratch.snapshot()).reservations, 0);
});

test('published inspection cancellation drains its reader before releasing scratch and admission', async t => {
  const f = await fixture(t); await f.media.ensurePinned(f.short); f.short.publication = 'published';
  f.media.privateMedia = undefined;
  let entered, finish, scanFile, scanSignal;
  const started = new Promise(resolve => { entered = resolve; }), drained = new Promise(resolve => { finish = resolve; });
  f.media.safety.scan = async (file, signal, force) => {
    scanFile = file; scanSignal = signal; assert.equal(force, true); entered();
    await drained;
    assert.deepEqual(await readFile(file.path), Buffer.alloc(1048600, 37));
    return { status: 'no_flags', sourceSha256: file.sha256 };
  };
  const cancel = new AbortController(), pending = f.media.rescan(f.short, cancel.signal).then(() => null, error => error);
  await started; cancel.abort();
  try {
    assert.equal(scanSignal.aborted, true); assert.equal(f.active(), 1);
    assert.equal((await f.scratch.snapshot()).reservations, 1);
    assert.deepEqual(await readFile(scanFile.path), Buffer.alloc(1048600, 37));
  } finally { finish(); }
  assert.equal((await pending).name, 'AbortError'); assert.equal(f.active(), 0);
  assert.deepEqual(await readdir(f.scratch.directory), []);
  assert.equal((await f.scratch.snapshot()).reservations, 0);
});

test('package identities reject mixed groups and incomplete or oversized retained assets', async t => {
  const f = await fixture(t);
  for (const kind of ['inputs', 'assets']) await assert.rejects(f.packages.derivativeCid(f.files, kind), /Invalid derivative package/);
  await assert.rejects(f.packages.derivativeCid(derivedFiles(f.files, 'inputs').slice(0, 1), 'inputs'));
  const assets = derivedFiles(f.files, 'assets');
  await assert.rejects(f.packages.derivativeCid(assets.slice(0, 2), 'assets'));
  await assert.rejects(f.packages.derivativeCid(assets.map(file => ({ ...file, bytes: 67108864 })), 'assets'), /exceeds media budget/);
});

test('poster and preview reads survive a missing input pin, while recovery repairs only the lost package', async t => {
  const f = await fixture(t); await f.media.ensurePinned(f.short);
  f.pins.delete(f.short.derivatives.cid);
  for (const name of ['poster.jpg', 'video.mp4'])
    assert.deepEqual(await f.media.retrieve(f.short, name), f.pins.get(f.short.derivatives.assetsCid).get(name));
  assert.equal(f.adds.length, 3);
  await f.media.ensurePinned(f.short); assert.equal(f.adds.length, 4);
  assert.deepEqual(f.adds.at(-1), { directory: true, cid: f.short.derivatives.cid });
  f.pins.get(f.short.derivatives.assetsCid).get('poster.jpg')[0] ^= 1;
  await assert.rejects(f.media.ensurePinned(f.short), /integrity mismatch/);
  assert.equal(f.active(), 0); assert.deepEqual(await readdir(f.scratch.directory), []);
});

test('a partial pin handoff recovers and corrupted pinned originals fail verification', async t => {
  const f = await fixture(t), fetch = f.media.ipfsFetch;
  let fail = true;
  f.media.ipfsFetch = async (path, request) => {
    if (fail && path.startsWith('add?wrap-with-directory=true')) return new Response(null, { status: 503 });
    return fetch(path, request);
  };
  await assert.rejects(f.media.ensurePinned(f.short), { status: 503 });
  assert.equal(f.pins.has(f.short.cid), true); assert.equal(f.active(), 0);
  assert.deepEqual(await readdir(f.scratch.directory), []);
  fail = false; await f.media.ensurePinned(f.short);
  assert.equal(f.adds.filter(add => !add.directory).length, 1);
  f.pins.get(f.short.cid)[0] ^= 1;
  await assert.rejects(f.media.ensurePinned(f.short), /integrity mismatch/);
  assert.equal(f.active(), 0);
});

test('cancellation during original pin drains scratch and releases admission without publishing derivatives', async t => {
  const f = await fixture(t), fetch = f.media.ipfsFetch, cancel = new AbortController();
  f.media.ipfsFetch = async (path, request) => {
    if (path.startsWith('add?wrap-with-directory=false')) cancel.abort();
    return fetch(path, request);
  };
  await assert.rejects(f.media.ensurePinned(f.short, cancel.signal));
  assert.equal(f.adds.length, 0); assert.equal(f.active(), 0);
  assert.deepEqual(await readdir(f.scratch.directory), []);
  assert.equal((await f.scratch.snapshot()).reservations, 0);
});

test('offline Kubo reproduces all three CIDs and keeps durable assets readable after unpinning inputs',
  { skip: !process.env.SHORTS_TEST_KUBO_API, timeout: 30000 }, async t => {
    const endpoint = new URL(process.env.SHORTS_TEST_KUBO_API);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const f = await fixture(t);
    f.media.ipfsFetch = (path, request) => fetch(`${endpoint.href}/${path}`, { ...request, redirect: 'error' });
    try {
      await f.media.ensurePinned(f.short);
      await f.media.ensurePinned(f.short);
      assert.equal(await f.media.pinned(f.short.cid), true);
      assert.equal(await f.media.pinned(f.short.derivatives.cid), true);
      assert.equal(await f.media.pinned(f.short.derivatives.assetsCid), true);
      const response = await fetch(`${endpoint.href}/cat?arg=${f.short.cid}`, { method: 'POST' });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(1048600, 37));
      const unpin = await fetch(`${endpoint.href}/pin/rm?arg=${f.short.derivatives.cid}`, { method: 'POST' });
      assert.equal(unpin.status, 200); await unpin.body?.cancel();
      assert.equal(await f.media.pinned(f.short.derivatives.cid), false);
      assert.equal(await f.media.pinned(f.short.derivatives.assetsCid), true);
      assert.deepEqual(await f.media.retrieve(f.short, 'poster.jpg'), Buffer.from('owned bytes for poster.jpg'));
      // Canonical IPFS bytes suffice even when encrypted upload inputs are gone.
      f.media.privateMedia = undefined;
      f.short.publication = 'published';
      assert.equal((await f.media.rescan(f.short)).sourceSha256, f.short.original.sha256);
      assert.deepEqual(await f.media.preview(f.short), Buffer.from('owned bytes for video.mp4'));
      await f.media.withPinnedOriginal(f.short, async (file, signal) => {
        signal.throwIfAborted();
        assert.deepEqual(await readFile(file.path), Buffer.alloc(1048600, 37));
        assert.equal(file.sha256, f.short.original.sha256);
        assert.equal(await f.packages.originalCid(file, signal), f.short.cid);
      });
      assert.equal(await f.media.pinned(f.short.cid), true);
      assert.equal(f.active(), 0);
      assert.deepEqual(await readdir(f.scratch.directory), []);
    } finally {
      for (const cid of [f.short.cid, f.short.derivatives.cid, f.short.derivatives.assetsCid]) {
        const response = await fetch(`${endpoint.href}/pin/rm?arg=${cid}`, { method: 'POST' });
        await response.body?.cancel();
      }
    }
  });

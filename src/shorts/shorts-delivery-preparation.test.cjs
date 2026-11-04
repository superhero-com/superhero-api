require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsService } = require('./shorts.service');
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsStreamingService } = require('./shorts-streaming.service');
const { ShortsDeliveryPreparationService } = require('./shorts-delivery-preparation.service');
const { ShortsDeliveryGenerationsService } = require('./shorts-delivery-generations.service');
const { assertOriginalDeliveryEligible } = require('./shorts-delivery-eligibility');
const { sourceKey, validateSourcePackage } = require('./hls-protocol/hls-package');
const golden = require('./testing/hls-v3.json');
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const original = { ...structuredClone(golden.descriptor), creator: 'ak_creator', title: 'Unchanged title', topic: 'Art', duration: 6,
    publication: 'published', moderation: 'approved', safety: { status: 'no_flags', sourceSha256: golden.descriptor.original.sha256 } };
  const record = structuredClone(original);
  record.id = 'delivery_2'; delete record.publication; record.moderation = 'pending';
  record.derivatives.generation = { job: record.id, fence: '2' };
  record.derivatives.fingerprint = '9'.repeat(64);
  record.privateMedia = { version: 1, fence: '2', source: { processingProfile: 'original-h264-v1', bytes: record.bytes,
    sha256: record.original.sha256, manifest: 'private object location' } };
  record.safety.private = 'private review evidence';
  record.files[0].objectKey = 'private object key';
  const scope = { network: original.network, contract: original.contract };
  let afterRead = () => {};
  const generations = new ShortsDeliveryGenerationsService({ query: async () => {
    afterRead(); return [{ short_id: original.id, fence: '2', body: record }];
  } });
  const candidate = await generations.get(scope, record.id);
  let publication = { cid: original.cid, creator: original.creator, size: BigInt(original.bytes), withdrawn: false };
  const chain = { release: scope, state: { contract: scope.contract, shorts: [original] }, read: async () => publication };
  const shorts = new ShortsService(chain);
  shorts.deliveryGenerations = generations;
  return { original, candidate, record, shorts, withdraw: () => { publication = { ...publication, withdrawn: true }; },
    afterRead: value => { afterRead = value; } };
}

test('retired candidate preparation reuses durable HLS without restoring encoded inputs',async t=>{
  const f=await fixture(),calls=[];
  const media={ensurePinned:()=>assert.fail('Retired inputs must stay retired'),verifyDurableDelivery:async()=>{calls.push('durable');},
    verifyPreparedDelivery:async()=>{calls.push('verify');return golden.package;}};
  const streaming={prepareGeneration:async()=>{calls.push('stream');return golden.package;}};
  const packages={get:async()=>golden.package,acknowledge:async()=>{calls.push('ack');}};
  const retired={get:async()=>({inputCid:f.record.derivatives.cid,generationJobId:f.record.id})};
  const service=new ShortsDeliveryPreparationService(f.shorts,media,streaming,packages,retired);t.after(()=>service.onModuleDestroy());
  assert.deepEqual(await service.prepare(f.original.id,f.record.id),{status:'ready',sourceKey:f.candidate.sourceKey});
  assert.deepEqual(calls,['durable','stream','verify','ack']);
  calls.length=0;media.verifyDurableDelivery=async()=>{f.withdraw();};
  await assert.rejects(service.prepare(f.original.id,f.record.id),{status:404});assert.deepEqual(calls,[]);
});

test('only the same reviewed source, metadata and captions qualify for candidate delivery', async () => {
  const { original, record } = await fixture();
  assert.doesNotThrow(() => assertOriginalDeliveryEligible(original, record));
  for (const change of [
    item => { item.cid = 'bafy' + 'f'.repeat(50); }, item => { item.bytes++; },
    item => { item.original.sha256 = 'a'.repeat(64); }, item => { item.original.mediaType = 'video/quicktime'; },
    item => { item.creator = 'ak_other'; }, item => { item.title += ' changed'; }, item => { item.topic = 'News'; },
    item => { item.description = 'New description'; }, item => { item.language = 'en'; },
    item => { item.synthetic = true; }, item => { item.sponsored = true; }, item => { item.duration++; },
    item => { item.safety.sourceSha256 = 'a'.repeat(64); }, item => { item.safety.status = 'review'; },
    item => { item.safety.status = 'blocked'; }, item => { item.safety.status = 'error'; },
    item => { item.moderation = 'approved'; }, item => { item.publication = 'published'; },
    item => { item.captions = true; item.files.push({ name: 'captions.vtt', bytes: 20, sha256: 'a'.repeat(64) }); },
  ]) {
    const changed = structuredClone(record); change(changed);
    assert.throws(() => assertOriginalDeliveryEligible(original, changed));
  }
  const captioned = structuredClone(original), translated = structuredClone(record);
  for (const item of [captioned, translated]) {
    item.captions = true; item.files.push({ name: 'captions.vtt', bytes: 20, sha256: 'a'.repeat(64) });
  }
  assert.doesNotThrow(() => assertOriginalDeliveryEligible(captioned, translated));
  translated.files.at(-1).sha256 = 'b'.repeat(64);
  assert.throws(() => assertOriginalDeliveryEligible(captioned, translated), { status: 404 });
  for (const change of [item => { item.publication = 'withdrawn'; }, item => { item.moderation = 'rejected'; },
    item => { item.safety.sourceSha256 = 'f'.repeat(64); }]) {
    const changed = structuredClone(original); change(changed);
    assert.throws(() => assertOriginalDeliveryEligible(changed, record), { status: 404 });
  }
});

test('candidate and acknowledgement endpoints recheck the canonical post and redact private fields', async () => {
  const f = await fixture(), { id } = f.original, job = f.record.id;
  const descriptor = await f.shorts.playbackGeneration(id, job);
  assert.equal(descriptor.id, id); assert.equal(descriptor.cid, f.original.cid);
  assert.equal(descriptor.derivatives.generation.job, job);
  assert.doesNotMatch(JSON.stringify(descriptor), /private|moderation|safety/);
  assert.deepEqual(await f.shorts.playbackDescriptor(id), golden.descriptor, 'candidate does not change public playback');
  assert.deepEqual(await f.shorts.playbackVersion(id, golden.sourceKey), golden.descriptor);
  await assert.rejects(f.shorts.playbackVersion(id, f.candidate.sourceKey), { status: 404 }, 'prepared candidates have no selection history');
  let reads = 0;
  f.shorts.deliveryPackages = { get: async actual => { reads++; assert.deepEqual(actual, descriptor); return golden.package; } };
  assert.deepEqual(await f.shorts.generationPackage(id, job, sourceKey(descriptor)), { sourceKey: sourceKey(descriptor), prepared: golden.package });
  for (const key of ['bad', golden.sourceKey]) await assert.rejects(f.shorts.generationPackage(id, job, key), { status: 404 });
  assert.equal(reads, 1);
  f.afterRead(f.withdraw);
  await assert.rejects(f.shorts.playbackGeneration(id, job), { status: 404 }, 'withdrawal during generation read is checked');
  await assert.rejects(f.shorts.playbackVersion(id, golden.sourceKey), { status: 404 });
  const g = await fixture();
  g.shorts.deliveryPackages = { get: async () => { g.withdraw(); return golden.package; } };
  await assert.rejects(g.shorts.generationPackage(g.original.id, g.record.id, g.candidate.sourceKey), { status: 404 });
});

test('preparation acknowledges only verified packages and never selects the candidate', async t => {
  for (const phase of ['ready', 'preparing', 'pin', 'stream', 'verify', 'ack', 'corrupt']) await t.test(phase, async () => {
    const f = await fixture(), calls = [], before = structuredClone(f.original);
    const media = {
      ensurePinned: async record => { assert.equal(record, f.record); calls.push('pin'); if (phase === 'pin') f.withdraw(); },
      verifyPreparedDelivery: async () => { calls.push('verify'); if (phase === 'verify') f.withdraw(); if (phase === 'corrupt') throw new Error('Corrupt HLS'); return golden.package; },
    };
    const service = new ShortsDeliveryPreparationService(f.shorts, media, { prepareGeneration: async descriptor => {
      assert.deepEqual(descriptor, f.candidate.descriptor); calls.push('stream'); if (phase === 'stream') f.withdraw();
      return phase === 'preparing' ? undefined : golden.package;
    } }, { acknowledge: async () => { calls.push('ack'); if (phase === 'ack') f.withdraw(); } });
    try {
      if (['ready', 'preparing'].includes(phase)) assert.deepEqual(await service.prepare(f.original.id, f.record.id), { status: phase, sourceKey: f.candidate.sourceKey });
      else await assert.rejects(service.prepare(f.original.id, f.record.id), phase === 'corrupt' ? /Corrupt HLS/ : { status: 404 });
      const expected = phase === 'pin' ? ['pin'] : ['stream', 'preparing'].includes(phase) ? ['pin', 'stream']
        : ['verify', 'corrupt'].includes(phase) ? ['pin', 'stream', 'verify'] : ['pin', 'stream', 'verify', 'ack'];
      assert.deepEqual(calls, expected); assert.deepEqual(f.original, before); assert.equal(f.record.moderation, 'pending');
    } finally { await service.onModuleDestroy(); }
  });
});

test('preparation bounds concurrency and cancels in-flight transfers on shutdown', async () => {
  const f = await fixture(); let pins = 0, acknowledgements = 0;
  const service = new ShortsDeliveryPreparationService(f.shorts, { ensurePinned: async (_record, signal) => {
    pins++; await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } }, {}, { acknowledge: async () => { acknowledgements++; } });
  const first = service.prepare(f.original.id, f.record.id), second = service.prepare(f.original.id, f.record.id);
  const settled = Promise.allSettled([first, second]);
  await assert.rejects(service.prepare(f.original.id, f.record.id), { status: 503 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(pins, 2);
  await service.onModuleDestroy();
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.equal(acknowledgements, 0); assert.equal(service.pending.size, 0);
  await assert.rejects(service.prepare(f.original.id, f.record.id), { status: 503 });
});

test('operations authorization is rechecked before pinning and acknowledgement', async () => {
  for (const deniedAt of ['before-pin','before-ack']) {
    const f=await fixture(), calls=[];let denied=deniedAt==='before-pin';
    const service=new ShortsDeliveryPreparationService(f.shorts,{
      ensurePinned:async()=>{calls.push('pin');},verifyPreparedDelivery:async()=>{denied=true;return golden.package;}
    },{prepareGeneration:async()=>{calls.push('stream');return golden.package;}},{acknowledge:async()=>{calls.push('ack');}});
    try {
      await assert.rejects(service.prepare(f.original.id,f.record.id,undefined,async()=>{if(denied)throw Error('batch cancelled');}),/batch cancelled/);
      assert.deepEqual(calls,deniedAt==='before-pin'?[]:['pin','stream']);
    } finally {await service.onModuleDestroy();}
  }
});

async function server(t, handler) {
  const value = createServer(handler); value.listen(0, '127.0.0.1'); await once(value, 'listening');
  t.after(async () => { value.closeAllConnections(); await new Promise(resolve => value.close(resolve)); });
  return `http://127.0.0.1:${value.address().port}`;
}

test('generation HTTP client checks credentials, source binding, metadata bounds, redirects and cancellation', async t => {
  const f = await fixture(), env = { ...process.env }, directory = await mkdtemp(join(tmpdir(), 'delivery-key-'));
  t.after(async () => { process.env = env; await rm(directory, { recursive: true, force: true }); });
  let status = 200, body = { status: 'ready', sourceKey: f.candidate.sourceKey, prepared: golden.package }, requests = 0, credential = 'e'.repeat(64);
  const base = await server(t, (req, res) => {
    requests++; assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, `Bearer ${credential}`);
    assert.equal(req.url, `/internal/videos/${f.original.id}/generations/${f.record.id}/prepare`);
    res.writeHead(status, status === 302 ? { Location: base + '/redirected' } : {});
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  Object.assign(process.env, { NODE_ENV: 'test', SHORTS_STREAM_INTERNAL_URL: base, SHORTS_STREAM_KEY_FILE: join(directory, 'key') });
  await writeFile(process.env.SHORTS_STREAM_KEY_FILE, credential, { mode: 0o600 });
  const streaming = new ShortsStreamingService({}, {}, undefined, {});
  t.after(() => streaming.onModuleDestroy());
  assert.deepEqual(await streaming.prepareGeneration(f.candidate.descriptor), validateSourcePackage(f.candidate.descriptor, golden.package));
  credential = 'f'.repeat(64); await writeFile(process.env.SHORTS_STREAM_KEY_FILE, credential);
  status = 202; assert.equal(await streaming.prepareGeneration(f.candidate.descriptor), undefined);
  status = 200; body = { status: 'ready', sourceKey: golden.sourceKey, prepared: golden.package };
  await assert.rejects(streaming.prepareGeneration(f.candidate.descriptor), /source changed/);
  body = 'x'.repeat(147457); await assert.rejects(streaming.prepareGeneration(f.candidate.descriptor));
  status = 302; const count = requests;
  await assert.rejects(streaming.prepareGeneration(f.candidate.descriptor)); assert.equal(requests, count + 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(streaming.prepareGeneration(f.candidate.descriptor, cancelled.signal)); assert.equal(requests, count + 1);
  await assert.rejects(streaming.prepareGeneration(golden.descriptor), /unavailable/);
});

test('HLS verification streams every file, checks source identity and fails on corrupt bytes or missing durable pins', async t => {
  const f = await fixture(), env = { ...process.env }, prepared = structuredClone(golden.package), files = new Map();
  const original = Buffer.alloc(f.record.bytes, 37), assets = new Map();
  f.record.original.sha256 = f.record.privateMedia.source.sha256 = f.record.safety.sourceSha256 = hash(original);
  for (const file of f.record.files.filter(file => ['video.mp4', 'poster.jpg', 'manifest.json', 'captions.vtt'].includes(file.name))) {
    const bytes = Buffer.alloc(file.bytes, 23); file.sha256 = hash(bytes); assets.set(file.name, bytes);
  }
  f.candidate.descriptor = { ...require('./shorts-playback-descriptor').shortsPlaybackDescriptor(f.record,
    { network: golden.descriptor.network, contract: golden.descriptor.contract }), id: f.original.id };
  t.after(() => { process.env = env; });
  for (const file of prepared.files) {
    const bytes = file.name === 'index.m3u8' ? Buffer.from(prepared.playlist)
      : prepared.playlists[file.name] ? Buffer.from(prepared.playlists[file.name]) : Buffer.alloc(file.bytes, 17);
    file.sha256 = hash(bytes); files.set(file.name, bytes);
  }
  const pins = new Set([prepared.cid, f.record.cid, f.record.derivatives.assetsCid]);
  let corrupt, unpinAfterRead, reads = 0, active = 0;
  const base = await server(t, (req, res) => {
    const url = new URL(req.url, 'http://fixture'), arg = url.searchParams.get('arg');
    if (url.pathname === '/api/v0/pin/ls') {
      if (pins.has(arg)) return res.end(JSON.stringify({ Keys: { [arg]: { Type: 'recursive' } } }));
      res.writeHead(500); return res.end(JSON.stringify({ Code: 0, Message: `path '${arg}' is not pinned` }));
    }
    assert.equal(url.pathname, '/api/v0/cat'); assert.equal(req.method, 'POST');
    const [cid, name] = arg.split('/'); assert.ok([prepared.cid, f.record.cid, f.record.derivatives.assetsCid].includes(cid)); reads++;
    if (unpinAfterRead) pins.delete(unpinAfterRead);
    const bytes = Buffer.from(cid === f.record.cid ? original : cid === f.record.derivatives.assetsCid ? assets.get(name) : files.get(name));
    if ((name || 'original') === corrupt) bytes[0] ^= 1;
    res.write(bytes.subarray(0, 64)); res.end(bytes.subarray(64));
  });
  Object.assign(process.env, { NODE_ENV: 'test', SHORTS_IPFS_API: base + '/api/v0' }); delete process.env.SHORTS_IPFS_TOKEN_FILE;
  const media = new ShortsMediaService({}, undefined, { shared: true }, undefined, { acquire: async (_actor, signal) => {
    assert.ok(signal instanceof AbortSignal, 'delivery verification opts into cancellable capacity waiting');
    active++; return { signal: new AbortController().signal, release: async () => { active--; } };
  } });
  t.after(() => media.onModuleDestroy());
  assert.deepEqual(await media.verifyPreparedDelivery(f.record, f.candidate.descriptor, prepared), validateSourcePackage(f.candidate.descriptor, prepared));
  assert.equal(reads, prepared.files.length); assert.equal(active, 0);
  const wrong = structuredClone(f.candidate.descriptor); wrong.derivatives.fingerprint = 'a'.repeat(64);
  await assert.rejects(media.verifyPreparedDelivery(f.record, wrong, prepared), /source mismatch/); assert.equal(reads, prepared.files.length);
  corrupt = prepared.files.find(file => file.name.endsWith('.m4s')).name;
  await assert.rejects(media.verifyPreparedDelivery(f.record, f.candidate.descriptor, prepared), /integrity/); assert.equal(active, 0);
  corrupt = undefined; unpinAfterRead = f.record.cid;
  await assert.rejects(media.verifyPreparedDelivery(f.record, f.candidate.descriptor, prepared), /pin changed/); assert.equal(active, 0);
  pins.delete(prepared.cid); const count = reads;
  await assert.rejects(media.verifyPreparedDelivery(f.record, f.candidate.descriptor, prepared), /not recursively pinned/); assert.equal(reads, count);
  pins.add(prepared.cid); pins.add(f.record.cid); unpinAfterRead = undefined;
  const before = reads;
  await media.verifyDurableDelivery(f.record, f.candidate.descriptor, prepared);
  assert.equal(reads - before, 1 + assets.size + prepared.files.length);
  assert.equal(active, 0, 'sequential verification releases both capacity reservations');
  for (const name of ['original', 'poster.jpg']) {
    corrupt = name;
    await assert.rejects(media.verifyDurableDelivery(f.record, f.candidate.descriptor, prepared), /integrity/);
    assert.equal(active, 0);
  }
});

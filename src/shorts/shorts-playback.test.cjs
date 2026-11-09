const { originalRecord } = require('./testing/original-record.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortsService } = require('./shorts.service');
const { ShortsController } = require('./shorts.controller');
const { ShortsDeliverySelectionService } = require('./shorts-delivery-selection.service');
const { sourceKey } = require('./hls-protocol/hls-package');

test('playback rejects directory-only media', async () => {
  const f = fixture();
  delete f.short.original;
  delete f.short.derivatives;
  f.register();
  await assert.rejects(f.service.playbackDescriptor(f.short.id));
});

test('playback descriptors contain public file metadata only and match on-chain publication', async () => {
  const short = originalRecord('video-1', { creator: 'ak_creator', moderation: 'approved', safety: { status: 'no_flags', private: 'data' } });
  let published = { cid: short.cid, creator: short.creator, size: BigInt(short.bytes), withdrawn: false };
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: [short], contract: 'ct_fixture' }, read: async () => published };
  const service = new ShortsService(chain);
  const descriptor = await service.playbackDescriptor(short.id);
  assert.deepEqual(descriptor.files, short.files);
  assert.equal(descriptor.safety, undefined);
  for (const change of [undefined, { ...published, withdrawn: true }, { ...published, cid: 'wrong' }, { ...published, creator: 'wrong' }, { ...published, size: 13n }]) {
    const saved = published; published = change;
    await assert.rejects(service.playbackDescriptor(short.id), { status: 404 }); published = saved;
  }
  short.publication = 'withdrawn'; await assert.rejects(service.playbackDescriptor(short.id), { status: 404 });
  await assert.rejects(service.playbackDescriptor('unknown'), { status: 404 });
  await assert.rejects(service.playbackDescriptor('../bad'), { status: 404 });
  chain.read = async () => { throw new Error('chain offline'); }; delete short.publication;
  await assert.rejects(service.playbackDescriptor(short.id), /chain offline/);
});

test('legacy media endpoint does not fetch IPFS bytes', () => {
  const controller = new ShortsController({ media: { retrieve: () => { throw new Error('Must not fetch'); } } });
  assert.throws(() => controller.media(), { status: 410 });
});

test('original-file playback keeps canonical CID and original size while exposing only separate public rendition metadata', async () => {
  const hash = 'a'.repeat(64), cid = 'bafy' + 'a'.repeat(50), delivery = 'bafy' + 'b'.repeat(50);
  const original = { version: 1, sha256: hash, mediaType: 'video/quicktime', importProfile: 'unixfs-file-v1-262144' };
  const derivatives = { version: 1, cid: delivery, assetsCid: 'bafy' + 'e'.repeat(50), profile: 'original-h264-v1', fingerprint: hash, generation: { job: 'original-video', fence: '1' }, videos: [
    { name: 'video-1080.mp4', width: 1080, height: 1920, frameRate: '60000/1001' },
    { name: 'video-rescue.mp4', width: 144, height: 256, frameRate: '15000/1001' },
  ] };
  const files = ['video-1080.mp4', 'video-rescue.mp4', 'video.mp4', 'poster.jpg', 'manifest.json']
    .map(name => ({ name, bytes: 100, sha256: hash }));
  const short = { id: 'original-video', cid, creator: 'ak_creator', bytes: 5000, moderation: 'approved', safety: { status: 'no_flags' },
    original: { ...original, internal: 'private fixture' }, derivatives: { ...derivatives, internal: 'private fixture' },
    files: files.map(file => ({ ...file, objectKey: 'private fixture' })),
    privateMedia: { version: 1, fence: '1', source: { processingProfile: 'original-h264-v1', bytes: 5000, sha256: hash, manifest: 'private fixture' } } };
  let publication = { cid, creator: short.creator, size: 5000n, withdrawn: false };
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: [short] }, read: async () => publication };
  const service = new ShortsService(chain);
  assert.deepEqual(await service.playbackDescriptor(short.id), { id: short.id, cid, network: 'ae_uat', contract: 'ct_fixture', bytes: 5000, original, derivatives, files });
  for (const changed of [{ ...publication, cid: delivery }, { ...publication, size: 500n }]) {
    const saved = publication; publication = changed;
    await assert.rejects(service.playbackDescriptor(short.id), { status: 404 }); publication = saved;
  }
  short.derivatives.videos[0].frameRate = '61/1';
  await assert.rejects(service.playbackDescriptor(short.id), /Invalid original video rendition/);
});

test('playback health checks storage and contract access without exposing dependency details', async () => {
  let storage = true;
  let config = { like_fee: 1n };
  const service = new ShortsService({ read: async method => { assert.equal(method, 'get_config'); return config; } }, { health: async () => storage });
  assert.deepEqual(await service.playbackHealth(), { status: 'ready', protocol: 'shorts-playback-v1' });
  storage = false; await assert.rejects(service.playbackHealth(), { status: 503 });
  storage = true; config = undefined; await assert.rejects(service.playbackHealth(), { status: 503 });
  service.chain.read = async () => { throw new Error('private dependency path'); };
  await assert.rejects(service.playbackHealth(), error => error.status === 503 && !error.message.includes('private'));
});

test('durable delivery endpoint rechecks publication and cannot expose a different source generation', async () => {
  const fixture = require('./testing/hls-v3.json');
  const short = { ...structuredClone(fixture.descriptor), creator: 'ak_creator', moderation: 'approved', safety: { status: 'no_flags' } };
  let publication = { cid: short.cid, creator: short.creator, size: BigInt(short.bytes), withdrawn: false };
  const chain = { release: { network: short.network, contract: short.contract }, state: { contract: short.contract, shorts: [short] }, read: async () => publication };
  const service = new ShortsService(chain); let reads = 0;
  service.deliveryPackages = { get: async () => { reads++; return fixture.package; } };
  assert.deepEqual(await service.playbackPackage(short.id, fixture.sourceKey), { sourceKey: fixture.sourceKey, prepared: fixture.package });
  for (const key of ['bad', '0'.repeat(64)]) await assert.rejects(service.playbackPackage(short.id, key), { status: 404 });
  publication = { ...publication, withdrawn: true };
  await assert.rejects(service.playbackPackage(short.id, fixture.sourceKey), { status: 404 });
  assert.equal(reads, 1, 'revoked and mismatched requests never read durable metadata');
});

function fixture(changes = {}) {
  const short = originalRecord('video-1', { creator: 'creator', title: 'Owned clip', moderation: 'approved', safety: { status: 'no_flags' }, ...changes });
  const effects = [];
  let published;
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: [short] }, address: value => value,
    save: async () => {}, read: async method => method === 'has_liked' ? false : published,
    write: async () => { effects.push('publish'); published = { cid: short.cid, creator: short.creator, size: BigInt(short.bytes), likes: 0 }; },
  };
  const service = new ShortsService(chain, { pin: async () => effects.push('pin') },
    { counters: () => ({ views: 0 }) }, {}, {}, {}, { enqueue: () => effects.push('enqueue') });
  return { short, chain, service, effects,
    register: () => { published = { cid: short.cid, creator: short.creator, size: BigInt(short.bytes), likes: 0 }; short.publication = 'published'; },
  };
}

test('publication and every public metadata path deny unreviewed, failed, blocked and stale decisions', async t => {
  for (const [name, changes] of [
    ['unreviewed', { moderation: 'pending' }],
    ['rejected', { moderation: 'rejected' }],
    ['missing scan', { safety: undefined }],
    ['failed scan', { safety: { status: 'error' } }],
    ['blocked scan', { safety: { status: 'blocked' } }],
    ['unknown scan state', { safety: { status: 'unknown' } }],
    ['review not confirmed', { safety: { status: 'review', evidenceHash: 'receipt' } }],
    ['stale review', { safety: { status: 'review', evidenceHash: 'new' }, visualReviewHash: 'old' }],
  ]) await t.test(name, async () => {
    const f = fixture(changes);
    await assert.rejects(f.service.publish('creator', f.short.id), { status: 403 });
    assert.deepEqual(f.effects, []);
    assert.equal(f.short.publication, undefined, 'denied content does not get a recoverable publish intent');
    f.register();
    for (const read of ['playbackDescriptor', 'shared', 'ensurePlayable'])
      await assert.rejects(f.service[read](f.short.id), { status: 404 });
    assert.deepEqual(await f.service.list(), []);
    assert.equal((await f.service.list('creator', 'All', true)).length, 1, 'creator retains private status access');
    await assert.rejects(f.service.publish('creator', f.short.id), { status: 403 });
    assert.deepEqual(f.effects, []);
  });
});

test('approved content is playable, but revocation and a pending rescan immediately deny access', async () => {
  const f = fixture();
  await f.service.publish('creator', f.short.id);
  assert.deepEqual(f.effects, ['pin', 'publish', 'enqueue']);
  assert.equal((await f.service.shared(f.short.id)).status, 'active');
  assert.equal((await f.service.playbackDescriptor(f.short.id)).cid, f.short.cid);
  let finish;
  f.service.media.rescan = () => new Promise(resolve => { finish = resolve; });
  const scanning = f.service.rescan(f.short.id);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.playbackDescriptor(f.short.id), { status: 404 });
  finish({ status: 'no_flags' }); await scanning;
  assert.equal(f.short.moderation, 'pending', 'a fresh scan cannot inherit prior approval');
  await assert.rejects(f.service.shared(f.short.id), { status: 404 });
  f.short.moderation = 'approved';
  f.short.safety = { status: 'review', evidenceHash: 'current' };
  f.short.visualReviewHash = 'current';
  assert.equal((await f.service.shared(f.short.id)).status, 'active');
  f.short.moderation = 'rejected';
  await assert.rejects(f.service.playbackDescriptor(f.short.id), { status: 404 });
});

test('safety is rechecked after asynchronous storage or chain work', async () => {
  const f = fixture();
  f.service.media.pin = async () => { f.short.moderation = 'rejected'; };
  await assert.rejects(f.service.publish('creator', f.short.id), { status: 403 });
  assert.deepEqual(f.effects, [], 'a decision change during pinning cannot reach the signer');
  f.short.moderation = 'approved'; f.register();
  const read = f.chain.read;
  f.chain.read = async (...args) => { f.short.moderation = 'rejected'; return read(...args); };
  await assert.rejects(f.service.playbackDescriptor(f.short.id), { status: 404 });
});

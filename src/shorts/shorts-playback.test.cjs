const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortsService } = require('./shorts.service');
const { ShortsController } = require('./shorts.controller');

test('playback descriptors contain public file metadata only and match on-chain publication', async () => {
  const short = { id: 'video-1', cid: 'cid', creator: 'ak_creator', bytes: 12, files: [
    { name: 'video.mp4', bytes: 10, sha256: 'a'.repeat(64) },
    { name: 'poster.jpg', bytes: 2, sha256: 'b'.repeat(64) },
    { name: 'manifest.json', bytes: 20, sha256: 'c'.repeat(64) },
  ], moderation: 'approved', safety: { status: 'no_flags', private: 'data' } };
  let published = { cid: short.cid, creator: short.creator, size: 12n, withdrawn: false };
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: [short], contract: 'ct_fixture' }, read: async () => published };
  const service = new ShortsService(chain);
  assert.deepEqual(await service.playbackDescriptor(short.id), { id: short.id, cid: short.cid,
    network: 'ae_uat', contract: 'ct_fixture', files: short.files.slice(0,2) });
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

function fixture(changes = {}) {
  const short = { id: 'video-1', creator: 'creator', cid: 'cid', bytes: 12, title: 'Owned clip',
    moderation: 'approved', safety: { status: 'no_flags' }, files: [], ...changes };
  const effects = [];
  let published;
  const chain = { release: { network: 'ae_uat', contract: 'ct_fixture' }, state: { contract: 'ct_fixture', shorts: [short] }, address: value => value,
    save: async () => {}, read: async method => method === 'has_liked' ? false : published,
    write: async () => { effects.push('publish'); published = { cid: short.cid, creator: short.creator, size: 12n, likes: 0 }; },
  };
  const service = new ShortsService(chain, { pin: async () => effects.push('pin') },
    { counters: () => ({ views: 0 }) }, {}, {}, {}, { enqueue: () => effects.push('enqueue') });
  return { short, chain, service, effects,
    register: () => { published = { cid: short.cid, creator: short.creator, size: 12n, likes: 0 }; short.publication = 'published'; },
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
  assert.equal((await f.service.playbackDescriptor(f.short.id)).cid, 'cid');
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

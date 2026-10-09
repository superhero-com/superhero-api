const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShortsService } = require('./shorts.service');
const { ShortsController } = require('./shorts.controller');

test('playback descriptors contain public file metadata only and match on-chain publication', async () => {
  const short = { id: 'video-1', cid: 'cid', creator: 'ak_creator', bytes: 12, files: [
    { name: 'video.mp4', bytes: 10, sha256: 'a'.repeat(64) },
    { name: 'poster.jpg', bytes: 2, sha256: 'b'.repeat(64) },
    { name: 'manifest.json', bytes: 20, sha256: 'c'.repeat(64) },
  ], safety: { private: 'data' } };
  let published = { cid: short.cid, creator: short.creator, size: 12n, withdrawn: false };
  const chain = { state: { shorts: [short] }, read: async () => published };
  const service = new ShortsService(chain);
  assert.deepEqual(await service.playbackDescriptor(short.id), { id: short.id, cid: short.cid, files: short.files.slice(0,2) });
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

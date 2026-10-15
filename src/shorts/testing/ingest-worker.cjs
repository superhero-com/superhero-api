// Isolated crash-test worker. Uses synthetic local media and never calls a node,
// signer, scanner or IPFS endpoint. The test supplies a fresh private data directory.
require('reflect-metadata');
const { createHash } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { ShortsStoreService } = require('../shorts-store.service');
const { ShortsWorkQueueService } = require('../shorts-work-queue.service');
const { ShortsMediaService } = require('../shorts-media.service');
const { ShortsService } = require('../shorts.service');
const { ShortsUploadsService } = require('../shorts-uploads.service');
const { ShortsUploadLimitsService } = require('../shorts-upload-limits.service');

async function main() {
  const mode = process.env.INGEST_TEST_MODE;
  const store = new ShortsStoreService(), work = new ShortsWorkQueueService();
  const media = new ShortsMediaService({ demoAutoApprove: true });
  await media.onModuleInit();
  const chain = { state: store.load() || { shorts: [], receipts: [] }, address: v => v,
    serial: fn => work.run(fn), save: async () => store.save(chain.state),
    registerPrepared: short => { chain.state.shorts.unshift(short); store.save(chain.state); return short; } };
  const counter = join(process.env.SHORTS_DATA_DIR, 'test-preparations');
  media.prepare = async (id, bytes) => {
    const previous = Number(await readFile(counter, 'utf8').catch(() => '0'));
    await writeFile(counter, String(previous + 1));
    await media.store(id, 'original', bytes);
    if (mode === 'processing') {
      process.send({ stage: 'processing' });
      await new Promise(() => {});
    }
    return { cid: 'bafy-synthetic', bytes: bytes.length, duration: 2, files: [] };
  };
  const limits = new ShortsUploadLimitsService(store);
  const shorts = new ShortsService(chain, media, {}, {}, {}, {}, {}, limits);
  const uploads = new ShortsUploadsService(store, shorts, limits);
  if (mode === 'registered') uploads.complete = async () => {
    process.send({ stage: 'registered' });
    await new Promise(() => {});
  };
  if (mode !== 'recover') {
    const bytes = Buffer.from('owned synthetic fixture');
    const session = await uploads.create('creator', { title: 'Owned clip', topic: 'Art', rights: true,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), details: {} });
    await uploads.part('creator', session.id, 0, bytes);
    const status = await uploads.finish('creator', session.id);
    process.send({ stage: 'queued', status });
    if (mode !== 'queued') void uploads.drain();
  } else {
    await uploads.onApplicationBootstrap();
    await uploads.drain();
    const { id } = store.db.prepare('SELECT id FROM shorts_uploads').get();
    process.send({ stage: 'recovered', status: await uploads.get('creator', id),
      records: chain.state.shorts.length, receipts: chain.state.receipts.length,
      preparations: Number(await readFile(counter, 'utf8')) });
  }
  process.on('message', async message => {
    if (message !== 'close') return;
    await uploads.onModuleDestroy(); await work.onModuleDestroy(); store.onApplicationShutdown(); process.exit(0);
  });
}
main().catch(error => { process.send({ error: error.message }); process.exit(1); });

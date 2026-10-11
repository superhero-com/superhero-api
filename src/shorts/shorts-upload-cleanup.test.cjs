const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { DatabaseSync } = require('node:sqlite');
const root = mkdtempSync(join(tmpdir(), 'shorts-upload-test-'));
process.env.SHORTS_DATA_DIR = root;
process.env.SHORTS_IPFS_API = 'http://127.0.0.1:35002/api/v0';
process.env.NODE_ENV = 'test';
for (const key of ['SHORTS_IPFS_TOKEN_FILE', 'SHORTS_IPFS_APIS', 'SHORTS_IPFS_CREDENTIALS_FILE']) delete process.env[key];
const { ShortsMediaService } = require('./shorts-media.service');
const { ShortsService } = require('./shorts.service');
const { ShortsUploadsService } = require('./shorts-uploads.service');
const { ShortsUploadLimitsService } = require('./shorts-upload-limits.service');

test('failed upload cleanup and shared persistent attempt budgets', async t => {
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const media = new ShortsMediaService({ demoAutoApprove: true, scan: async () => undefined });
  await media.onModuleInit();
  const setup = () => {
    const db = new DatabaseSync(':memory:');
    const limits = new ShortsUploadLimitsService({ db });
    const chain = { state: { shorts: [] }, address: value => value, save: async () => {} };
    const shorts = new ShortsService(chain, media, {}, {}, { classify: async () => ({}) }, {}, {}, limits);
    const sessions = new ShortsUploadsService({ db }, shorts, limits);
    return { db, limits, chain, shorts, sessions };
  };
  const files = () => fs.readdir(join(root, 'private'));
  const invalid = Buffer.alloc(1024, 65);
  const input = { title: 'A clip', topic: 'Art', rights: true, bytes: invalid.length,
    sha256: createHash('sha256').update(invalid).digest('hex'), details: {} };

  await t.test('invalid legacy uploads leave no files, count failures, and keep limits after restart', async () => {
    const { db, chain, shorts } = setup();
    try {
      for (let i = 0; i < 10; i++) await assert.rejects(shorts.upload('creator', 'Clip', 'Art', invalid), /ffprobe/);
      assert.deepEqual(await files(), []); assert.equal(chain.state.shorts.length, 0);
      const restarted = new ShortsService(chain, media, {}, {}, {}, {}, {}, new ShortsUploadLimitsService({ db }));
      await assert.rejects(restarted.upload('creator', 'Clip', 'Art', invalid), /10 upload attempts/);
      assert.equal(db.prepare('SELECT count(*) AS n FROM shorts_upload_attempts').get().n, 10);
    } finally { db.close(); }
  });
  await t.test('resumable creation and legacy uploads share one allowance', async () => {
    const { db, shorts, sessions } = setup();
    try {
      for (let i = 0; i < 9; i++) await sessions.create('creator', input);
      await assert.rejects(shorts.upload('creator', 'Clip', 'Art', invalid), /ffprobe/);
      await assert.rejects(sessions.create('creator', input), /10 upload attempts/);
      await assert.rejects(shorts.upload('creator', 'Clip', 'Art', invalid), /10 upload attempts/);
      assert.deepEqual(await files(), []);
    } finally { db.close(); }
  });
  await t.test('failed finishes are charged on retry while resumable parts stay bounded and reusable', async () => {
    const { db, sessions } = setup();
    try {
      const session = await sessions.create('creator', input);
      await sessions.part('creator', session.id, 0, invalid);
      for (let i = 0; i < 10; i++) await assert.rejects(sessions.finish('creator', session.id), /ffprobe/);
      await assert.rejects(sessions.finish('creator', session.id), /10 upload attempts/);
      assert.deepEqual(await files(), [`${session.id}-part-0.enc`]);
      await media.removeUploadParts(session.id, 1);
    } finally { db.close(); }
  });
  await t.test('byte and global attempt limits reject before storage', () => {
    const { db, limits } = setup();
    try {
      assert.throws(() => limits.reserve('creator', randomUUID(), 40 * 1024 * 1024 + 1), /40 MB/);
      for (let i = 0; i < 100; i++) limits.reserve(`creator-${i}`, randomUUID(), 40 * 1024 * 1024);
      assert.throws(() => limits.reserve('other', randomUUID(), 1), /capacity/);
    } finally { db.close(); }
  });

  const source = join(root, 'source.mp4');
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x48:r=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const video = await fs.readFile(source);
  await t.test('post-transcode provider and partial storage failures remove every prepared file', async () => {
    const originalAdd = media.add, originalStore = media.store;
    try {
      media.add = async () => { throw new Error('IPFS unavailable'); };
      await assert.rejects(media.prepare(randomUUID(), video, 'Clip', 'Art'), /IPFS unavailable/);
      assert.deepEqual(await files(), []);
      media.store = async (id, name, data) => {
        if (name === 'poster.jpg') throw new Error('disk full');
        return originalStore.call(media, id, name, data);
      };
      await assert.rejects(media.prepare(randomUUID(), video, 'Clip', 'Art'), /disk full/);
      assert.deepEqual(await files(), []);
      assert.equal((await fs.readdir(root)).some(name => name.startsWith('transcode-')), false);
    } finally { media.add = originalAdd; media.store = originalStore; }
  });
  await t.test('registration failure removes prepared packages and rolls back the in-memory draft', async () => {
    const { db, chain, shorts } = setup(); const add = media.add;
    try {
      media.add = async () => 'bafy-test'; chain.save = async () => { throw new Error('registry write failed'); };
      await assert.rejects(shorts.upload('creator', 'Clip', 'Art', video), /registry write failed/);
      assert.equal(chain.state.shorts.length, 0); assert.deepEqual(await files(), []);
    } finally { db.close(); media.add = add; }
  });
  await t.test('startup removes orphan originals/packages but preserves registered media and session parts', async () => {
    const registered = randomUUID(), orphan = randomUUID();
    await media.store(registered, 'original', video);
    await media.store(orphan, 'original', video);
    await media.store(orphan, 'video.mp4', video);
    await media.saveUploadPart(orphan, 0, invalid);
    await media.removeOrphanedPrepared(new Set([registered]));
    assert.deepEqual((await files()).sort(), [`${registered}-original.enc`, `${orphan}-part-0.enc`].sort());
    await media.removePrepared(registered); await media.removeUploadParts(orphan, 1);
  });
});

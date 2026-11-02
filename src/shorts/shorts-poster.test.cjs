require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, rm, copyFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsScratchService, ShortsScratchProbeService } = require('./shorts-scratch.service');
const { ShortsRenditionEncodingService } = require('./shorts-rendition-encoding.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { hashMediaFile } = require('./shorts-media-file');
const { shortsPosterFrame, SHORTS_POSTER_MAX_FRAMES, SHORTS_POSTER_SAMPLE_BYTES } = require('./shorts-poster');
const exec = promisify(execFile);
const run = (args, options = {}) => exec('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...args],
  { timeout: 60000, maxBuffer: 1048576, ...options });

test('poster selection bounds decoded work and preserves dark or flat content', () => {
  const frame = (a, b = a) => Buffer.from(Array.from({ length: SHORTS_POSTER_SAMPLE_BYTES }, (_, i) => i % 2 ? a : b));
  assert.equal(shortsPosterFrame(Buffer.concat([frame(0), frame(255), frame(30, 200)])), 2);
  assert.equal(shortsPosterFrame(Buffer.concat([frame(0), frame(4, 16)])), 1, 'dark scene is preferable to blank');
  assert.equal(shortsPosterFrame(Buffer.concat([frame(0), frame(70)])), 1, 'uniform color remains valid');
  assert.equal(shortsPosterFrame(Buffer.concat([frame(0), frame(0)])), 0);
  assert.equal(shortsPosterFrame(Buffer.concat([frame(30, 200), frame(30, 200)])), 0, 'stable ties');
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(13), Buffer.alloc((SHORTS_POSTER_MAX_FRAMES + 1) * SHORTS_POSTER_SAMPLE_BYTES)])
    assert.throws(() => shortsPosterFrame(invalid));
});

for (const [label, video, visible] of [
  ['opening black', "color=black:s=320x180:r=30:d=4,drawbox=x=20:y=20:w=140:h=140:color=red:t=fill:enable='gte(t,2)',drawbox=x=180:y=20:w=120:h=140:color=white:t=fill:enable='gte(t,2)'", true],
  ['one visible frame', "color=black:s=320x180:r=30:d=4,drawbox=x=20:y=20:w=140:h=140:color=red:t=fill:enable='eq(n,103)',drawbox=x=180:y=20:w=120:h=140:color=white:t=fill:enable='eq(n,103)'", true],
  ['entirely black', 'color=black:s=320x180:r=30:d=2', false],
]) test(`source poster handles ${label} without modifying original bytes`, { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-poster-'));
  const scratch = new ShortsScratchService({ directory: join(directory, 'work'), minFreeBytes: 64 * 1048576,
    minFreeInodes: 128, maxUsedPercent: Number(process.env.SHORTS_TEST_SCRATCH_MAX_USED_PERCENT || 85) }, new ShortsScratchProbeService());
  await scratch.onModuleInit();
  t.after(async () => { scratch.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'original.mp4');
  await run(['-f', 'lavfi', '-i', video, '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', path]);
  const source = await hashMediaFile(path), packages = new ShortsPackageService();
  const cid = await packages.originalCid(source);
  await new ShortsRenditionEncodingService(scratch, packages).prepare(source, async output => {
    assert.equal(output.originalCid, cid);
    const poster = output.files.find(file => file.name === 'poster.jpg');
    const { stdout } = await run(['-i', poster.path, '-vf', 'scale=32:18', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
    assert.equal(stdout.length, 32 * 18);
    assert.equal(stdout.some(value => value > 120), visible, 'poster must depict available content');
    if (process.env.SHORTS_TEST_POSTER_EVIDENCE) await copyFile(poster.path, join(process.env.SHORTS_TEST_POSTER_EVIDENCE, label.replaceAll(' ', '-') + '.jpg'));
  });
  assert.deepEqual(await hashMediaFile(path), source);
  assert.deepEqual(await readdir(scratch.directory), []);
});

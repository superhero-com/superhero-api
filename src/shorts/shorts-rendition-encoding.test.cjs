require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readdir, readFile, copyFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsScratchService, ShortsScratchProbeService } = require('./shorts-scratch.service');
const { ShortsRenditionEncodingService } = require('./shorts-rendition-encoding.service');
const { shortsVideoProbe, shortsRenditions } = require('./shorts-rendition-policy');
const { hashMediaFile } = require('./shorts-media-file');
const { ShortsPackageService } = require('./shorts-package.service');
const { ShortsMediaWorkerService } = require('./shorts-media-worker.service');
const { validateOriginalContent } = require('./shorts-original-content');
const { encodingFingerprint } = require('./shorts-encoding-recipe');
const exec = promisify(execFile);

const probe = overrides => shortsVideoProbe({
  format: { duration: '2', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '60000/1001', ...overrides }],
});

test('ladder preserves orientation and fractional cadence without upscaling small sources', () => {
  const portrait = shortsRenditions(probe());
  assert.deepEqual(portrait.map(v => [v.width, v.height]), [[1080,1920], [720,1280], [480,852], [360,640], [144,256]]);
  assert.equal(portrait[0].frameRate, '60000/1001');
  assert.equal(portrait[1].frameRate, '60000/2002');
  assert.equal(portrait[4].frameRate, '60000/4004');
  const landscape = shortsRenditions(probe({ width: 1920, height: 1080 }));
  assert.deepEqual([landscape[0].width, landscape[0].height], [1920,1080]);
  const rotated = shortsRenditions(probe({ width: 1920, height: 1080, side_data_list: [{ rotation: 90 }] }));
  assert.deepEqual([rotated[0].width, rotated[0].height], [1080,1920]);
  const small = shortsRenditions(probe({ width: 320, height: 180, avg_frame_rate: '24/1' }));
  assert.equal(small.length, 2); assert.deepEqual([small[0].width, small[0].height], [320,180]);
});

test('probe rejects unbounded work and unsupported color metadata', () => {
  for (const invalid of [{ width: 3842, height: 2160 }, { width: 100000, height: 2 }, { avg_frame_rate: '0/0' },
    { avg_frame_rate: '241/1' }, { codec_name: 'unknown' }, { side_data_list: [{ rotation: 45 }] },
    { side_data_list: [{ side_data_type: 'DOVI configuration record' }] }, { color_transfer: 'smpte2084' }])
    assert.throws(() => probe(invalid));
  assert.equal(probe({ color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }).hdr, true);
});

async function fixture(t, { size = '1080x1920', fps = '30', audio = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-rendition-test-'));
  const maxUsedPercent = Number(process.env.SHORTS_TEST_SCRATCH_MAX_USED_PERCENT || 85);
  assert.ok(Number.isInteger(maxUsedPercent) && maxUsedPercent >= 50 && maxUsedPercent <= 99);
  const scratch = new ShortsScratchService({ directory: join(directory, 'work'), minFreeBytes: 64 * 1048576, minFreeInodes: 128, maxUsedPercent }, new ShortsScratchProbeService());
  await scratch.onModuleInit();
  t.after(async () => { scratch.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'original.mp4');
  const args = ['-nostdin', '-y', '-v', 'error', '-filter_threads', '1', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${fps}:d=2`];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2');
  await exec('ffmpeg', [...args, '-map', '0:v:0', ...(audio ? ['-map', '1:a:0', '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', path], { timeout: 60000 });
  return { scratch, source: await hashMediaFile(path), encoder: new ShortsRenditionEncodingService(scratch, new ShortsPackageService()) };
}

test('original produces separate playable video/audio tracks and cleans scratch after persistence', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  let paths;
  const result = await f.encoder.prepare(f.source, async output => {
    assert.equal(output.videos.length, 5);
    assert.equal(output.files.length, 10);
    paths = output.files.map(file => file.path);
    for (const file of output.files) {
      assert.deepEqual(await hashMediaFile(file.path), { path: file.path, bytes: file.bytes, sha256: file.sha256 });
      if (file.name === 'poster.jpg') continue;
      if (file.name === 'manifest.json') {
        const manifest = JSON.parse(await readFile(file.path, 'utf8'));
        assert.equal(manifest.version, 2); assert.equal(manifest.original.sha256, f.source.sha256);
        assert.equal(manifest.original.cid, output.originalCid);
        assert.equal(output.originalCid, await new ShortsPackageService().originalCid(f.source));
        assert.equal(manifest.fingerprint, output.fingerprint);
        assert.equal(encodingFingerprint(manifest.recipe), output.fingerprint);
        assert.equal(manifest.recipe.commands.filter(command => command.program === 'ffmpeg').length, 10);
        assert.equal(manifest.recipe.commands[0].program, 'ffprobe');
        assert.doesNotMatch(JSON.stringify(manifest.recipe), /shorts-renditions-|shorts-rendition-test-/);
        continue;
      }
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file.path]);
      const media = JSON.parse(stdout);
      assert.equal(media.streams.length, file.name === 'video.mp4' ? 2 : 1);
      const track = media.streams[0];
      if (file.name.startsWith('video')) {
        const variant = output.videos.find(v => v.name === (file.name === 'video.mp4' ? 'video-480.mp4' : file.name));
        assert.equal(track.width, variant.width); assert.equal(track.height, variant.height);
        assert.equal(track.codec_name, 'h264'); assert.equal(track.pix_fmt, 'yuv420p');
        assert.equal(track.color_transfer, 'bt709');
        assert.equal(Number(track.nb_read_frames), file.name.includes('rescue') ? 30 : 60);
      } else {
        assert.equal(track.codec_name, 'aac'); assert.equal(track.sample_rate, '48000');
      }
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', file.path, '-f', 'null', '-']);
    }
    return 'persisted';
  });
  assert.equal(result, 'persisted');
  assert.deepEqual(await hashMediaFile(f.source.path), f.source);
  for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.scratch.directory), []);
  assert.equal((await f.scratch.snapshot()).reservations, 0);
});

test('small silent 60fps source keeps its cadence and releases work on persistence failure', { timeout: 60000 }, async t => {
  const f = await fixture(t, { size: '320x180', fps: '60', audio: false });
  await assert.rejects(f.encoder.prepare(f.source, async output => {
    assert.equal(output.videos.length, 2);
    assert.equal(output.files.length, 5);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', output.files[0].path]);
    const stream = JSON.parse(stdout).streams[0];
    assert.equal(stream.avg_frame_rate, '60/1'); assert.equal(Number(stream.nb_read_frames), 120);
    throw new Error('storage unavailable');
  }), /storage unavailable/);
  assert.deepEqual(await readdir(f.scratch.directory), []);
  assert.equal((await f.scratch.snapshot()).reservations, 0);
  await assert.rejects(f.encoder.prepare(f.source, async () => assert.fail('cancelled'), AbortSignal.abort()));
});

test('worker persists the exact original CID and a separate derivative package, then removes all scratch', { timeout: 60000 }, async t => {
  const f = await fixture(t, { size: '320x180', fps: '60', audio: true });
  const packages = new ShortsPackageService();
  const originalCid = await packages.originalCid(f.source);
  const scope = { network: 'ae_uat', contract: 'ct_fixture' };
  const job = { id: 'original', creator: 'ak_creator', fence: '1', leaseToken: 'fixture',
    input: { bytes: f.source.bytes, sha256: f.source.sha256, title: 'Original title', topic: 'Art',
      processingProfile: 'original-h264-v1', details: { captions: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n' } } };
  let stored, failed = 0;
  const persisted = new Map();
  const worker = new ShortsMediaWorkerService({ scope, leaseMs: 120000 }, {
    heartbeat: async () => true, fail: async () => { failed++; },
    complete: async (_scope, claim, content) => { assert.equal(claim.fence, '1'); stored = content; },
  }, {
    readToFile: async (_scope, _job, path) => { await copyFile(f.source.path, path); return { ...f.source, path }; },
  }, {
    putFile: async (_scope, id, slot, file) => {
      assert.equal(id, job.id); persisted.set(file.name, await readFile(file.path));
      return { key: slot, keyId: 'test', bytes: file.bytes, sha256: file.sha256 };
    },
  }, packages,
  { scan: async () => ({ status: 'no_flags', sourceSha256: f.source.sha256 }) },
  { classify: async () => undefined }, f.scratch, f.encoder);
  await worker.prepare(job, performance.now());
  assert.equal(failed, 0); assert.ok(stored); assert.equal(validateOriginalContent(stored), true);
  assert.equal(stored.cid, originalCid); assert.notEqual(stored.derivatives.cid, originalCid);
  assert.notEqual(stored.derivatives.assetsCid, stored.derivatives.cid);
  assert.notEqual(stored.derivatives.assetsCid, originalCid);
  assert.equal(stored.bytes, f.source.bytes); assert.equal(stored.original.sha256, f.source.sha256);
  assert.equal(stored.captions, true); assert.equal(persisted.size, 8);
  assert.equal(JSON.parse(persisted.get('manifest.json')).title, job.input.title);
  assert.equal(stored.derivatives.videos[0].frameRate, '60/1');
  assert.deepEqual(stored.derivatives.generation, { job: job.id, fence: job.fence });
  assert.deepEqual(await hashMediaFile(f.source.path), f.source);
  assert.deepEqual(await readdir(f.scratch.directory), []);
  assert.equal((await f.scratch.snapshot()).reservations, 0);
});

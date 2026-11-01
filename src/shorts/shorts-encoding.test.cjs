require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, writeFile, rm, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runtimeRequire, runtimeEvidence } = require('./testing/fixture-runtime.cjs');
const { ShortsEncodingService } = runtimeRequire('../shorts-encoding.service');
const { ShortsScratchService, ShortsScratchProbeService } = runtimeRequire('../shorts-scratch.service');
const exec = promisify(execFile);
const MiB = 1048576;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'shorts-encoding-test-'));
  const scratch = new ShortsScratchService({ directory: join(root, 'work'), minFreeBytes: 64 * MiB, minFreeInodes: 128, maxUsedPercent: 85 }, new ShortsScratchProbeService());
  await scratch.onModuleInit();
  t.after(async () => { scratch.onModuleDestroy(); await rm(root, { recursive: true, force: true }); });
  const encoder = new ShortsEncodingService(scratch);
  async function clean() {
    assert.deepEqual(await readdir(scratch.directory), []);
    assert.equal((await scratch.snapshot()).reservations, 0);
  }
  return { root, clean, encoder };
}
async function generate(root, { size = '128x128', fps = 30, duration = 2, codec = 'libx264', pixel = 'yuv420p', pattern = 'color=c=blue', extra = [] } = {}) {
  const path = join(root, 'source.mp4');
  const args = ['-nostdin', '-y', '-v', 'error', '-filter_threads', '1', '-f', 'lavfi', '-i', `${pattern}${pattern.includes("=") ? ":" : "="}s=${size}:r=${fps}`, '-t', String(duration), '-c:v', codec, '-threads', '2', '-pix_fmt', pixel];
  if (codec === 'libx264') args.push('-preset', 'ultrafast');
  if (codec === 'libx265') args.push('-preset', 'ultrafast', '-x265-params', 'pools=none:frame-threads=1:rc-lookahead=0:bframes=0:ref=1:log-level=error');
  await exec('ffmpeg', [...args, ...extra, path], { timeout: 120000, maxBuffer: MiB });
  const bytes = await readFile(path); assert.ok(bytes.length <= 40 * MiB);
  return bytes;
}
async function verify(f, output, expectedDuration) {
  const video = output.files.find(file => file.name === 'video.mp4').data;
  const path = join(f.root, 'prepared.mp4'); await writeFile(path, video);
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { timeout: 15000 });
  const probe = JSON.parse(stdout), stream = probe.streams.find(row => row.codec_type === 'video');
  assert.equal(stream.width, 540); assert.equal(stream.height, 960);
  assert.equal(stream.codec_name, 'h264'); assert.equal(stream.pix_fmt, 'yuv420p');
  assert.equal(stream.avg_frame_rate, '30/1');
  assert.ok(Math.abs(Number(probe.format.duration) - expectedDuration) <= 0.1);
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '2', '-i', path, '-f', 'null', '-'], { timeout: 60000 });
  assert.ok(output.files.find(file => file.name === 'poster.jpg').data.length > 0);
  assert.equal(JSON.parse(output.files.find(file => file.name === 'manifest.json').data).duration, expectedDuration);
  await f.clean();
}

for (const spec of [
  { name: 'minimum two-second video', duration: 2 },
  { name: '4K 60 fps video', size: '3840x2160', fps: 60, duration: 2 },
  { name: 'moving 4K 60 fps video with reference frames', size: '3840x2160', fps: 60, duration: 2, pattern: 'testsrc2', extra: ['-crf', '30', '-x264-params', 'ref=4:bframes=3'] },
  { name: '240 fps video', size: '1920x1080', fps: 240, duration: 2 },
  { name: '4K 10-bit HEVC video', size: '3840x2160', codec: 'libx265', pixel: 'yuv420p10le', duration: 2 },
  { name: 'odd-sized 4:4:4 video', size: '321x181', pixel: 'yuv444p', pattern: 'nullsrc', duration: 2 },
  { name: 'maximum sixty-second video', size: '540x960', duration: 60 },
]) test(`normalizes ${spec.name} within worker resource limits`, { timeout: 240000 }, async t => {
  const f = await fixture(t), bytes = await generate(f.root, spec), started = Date.now();
  const output = await f.encoder.encode(bytes, 'Owned boundary fixture', 'Art');
  await verify(f, output, spec.duration);
  t.diagnostic(JSON.stringify({ case: spec.name, inputBytes: bytes.length, outputBytes: output.bytes, elapsedMs: Date.now() - started, ...runtimeEvidence() }));
});

test('rejects malformed, truncated, oversize, too-short, too-long and over-4K media and releases scratch', { timeout: 240000 }, async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from('not an MP4'), Buffer.alloc(0), Buffer.alloc(40 * MiB + 1),
    await generate(f.root, { duration: 1 }), await generate(f.root, { duration: 61 }),
    await generate(f.root, { size: '3842x2160' })]) {
    await assert.rejects(f.encoder.encode(bytes, 'Invalid fixture', 'Art'));
    await f.clean();
  }
  const original = await generate(f.root, { duration: 3, extra: ['-movflags', '+faststart'] });
  await assert.rejects(f.encoder.encode(original.subarray(0, Math.floor(original.length * 0.85)), 'Truncated fixture', 'Art'));
  await f.clean();
});


test('honors phone rotation before making the portrait video and clears scratch', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await generate(f.root, { size: '320x180', duration: 2, extra: ['-vf', 'drawbox=x=0:y=0:w=160:h=180:c=red:t=fill'] });
  const rotated = join(f.root, 'rotated.mp4');
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-display_rotation:v:0', '90', '-i', join(f.root, 'source.mp4'), '-c', 'copy', rotated]);
  const { stdout: rotation } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', rotated]);
  assert.ok(JSON.parse(rotation).streams[0].side_data_list.some(item => item.rotation === 90), 'fixture must contain a 90 degree display matrix');
  const output = await f.encoder.encode(await readFile(rotated), 'Rotated fixture', 'Art');
  await verify(f, output, 2);
  const { stdout: pixels } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', '-i', join(f.root, 'prepared.mp4'), '-filter_threads', '1', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * MiB });
  const top = (120 * 540 + 270) * 3, bottom = (840 * 540 + 270) * 3;
  t.diagnostic(JSON.stringify({ top: [...pixels.subarray(top, top + 3)], bottom: [...pixels.subarray(bottom, bottom + 3)] }));
  assert.ok(pixels[top + 2] > pixels[top] + 100, 'blue half must be above red after rotation');
  assert.ok(pixels[bottom] > pixels[bottom + 2] + 100, 'red half must be below blue after rotation');
});

test('publishes the first video track even when another larger track is the default', { timeout: 30000 }, async t => {
  const f = await fixture(t), source = join(f.root, 'multi-track.mp4');
  await exec('ffmpeg', ['-nostdin', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=128x128:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=red:s=256x256:r=10:d=2',
    '-map', '0:a:0', '-map', '1:v:0', '-map', '2:v:0',
    '-c:a', 'aac', '-c:v', 'libx264', '-threads', '1',
    '-disposition:v:0', '0', '-disposition:v:1', 'default', source], { timeout: 15000 });
  const { stdout: streams } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', source]);
  assert.deepEqual(JSON.parse(streams).streams.map(stream => stream.codec_type), ['audio', 'video', 'video']);
  const output = await f.encoder.encode(await readFile(source), 'Multiple tracks', 'Art');
  await verify(f, output, 2);
  const { stdout: pixels } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1',
    '-i', join(f.root, 'prepared.mp4'), '-an', '-filter_threads', '1', '-frames:v', '1',
    '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * MiB });
  const center = (480 * 540 + 270) * 3;
  assert.ok(pixels[center + 2] > pixels[center] + 100, 'published pixels must be from the first blue track');
});

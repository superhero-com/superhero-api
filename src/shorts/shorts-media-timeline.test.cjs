require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, rm, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { ShortsScratchService, ShortsScratchProbeService } = require('./shorts-scratch.service');
const { ShortsRenditionEncodingService } = require('./shorts-rendition-encoding.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { hashMediaFile } = require('./shorts-media-file');
const exec = promisify(execFile);
const events = [0.7, 1.9, 3.3];
const command = (program, args, options = {}) => exec(program, args,
  { timeout: 60000, maxBuffer: 8 * 1048576, ...options });
const inspect = async path => JSON.parse((await command('ffprobe', ['-v', 'error', '-count_frames',
  '-show_streams', '-show_format', '-of', 'json', path])).stdout);

async function fixture(t, { audioOffset = 0, videoOffset = 0, vfr = false,
  fps = '30', silent = false, rotate = false, audioEnd = 4, audioGap = false, channels = 1,
  counter = false, duration = 4 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shorts-media-timeline-'));
  const scratch = new ShortsScratchService({ directory: join(directory, 'work'),
    minFreeBytes: 64 * 1048576, minFreeInodes: 128,
    maxUsedPercent: Number(process.env.SHORTS_TEST_SCRATCH_MAX_USED_PERCENT || 85) }, new ShortsScratchProbeService());
  await scratch.onModuleInit();
  t.after(async () => { scratch.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  const flashes = events.map(at => `between(t,${at - videoOffset},${at - videoOffset + 0.1})`).join('+');
  const pulses = events.map(at => `between(t,${at - audioOffset},${at - audioOffset + 0.1})`).join('+');
  const sound = Array.from({ length: channels }, () => `0.2*sin(2*PI*1000*t)*(${pulses})`).join('|');
  const bars = Array.from({ length: 16 }, (_, bit) => `drawbox=x=${20 * bit}:y=0:w=20:h=180:color=white:t=fill:enable='mod(floor(n/${2 ** bit}),2)'`).join(',');
  const video = counter ? `color=black:s=320x180:r=${fps}:d=${duration},${bars}`
    : rotate ? `color=red:s=320x180:r=${fps}:d=4,drawbox=x=160:y=0:w=160:h=180:color=green:t=fill,setsar=4/3`
    : `color=black:s=320x180:r=${fps}:d=${4 - videoOffset},drawbox=color=white:t=fill:enable='${flashes}'`;
  const path = join(directory, rotate ? 'source.mov' : 'source.mp4');
  const raw = rotate ? join(directory, 'unrotated.mov') : path;
  await command('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-filter_threads', '1',
    '-itsoffset', String(videoOffset), '-f', 'lavfi', '-i', video,
    ...(!silent ? ['-itsoffset', String(audioOffset), '-f', 'lavfi', '-i',
      `aevalsrc='${sound}':s=48000:d=${audioEnd - audioOffset}:c=${channels === 6 ? '5.1' : channels === 2 ? 'stereo' : 'mono'}${audioGap ? `,aselect='not(between(t,1,${1 + (typeof audioGap === 'number' ? audioGap : 0.3)}))'` : ''}`] : []),
    '-map', '0:v:0', ...(!silent ? ['-map', '1:a:0', '-c:a', 'aac'] : []),
    ...(vfr ? ['-vf', "select='if(lt(t,2),not(mod(n,3)),1)'", '-fps_mode', 'vfr'] : ['-fps_mode', 'passthrough']),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p', raw]);
  if (rotate) await command('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-display_rotation:v:0', '90', '-i', raw,
    '-c', 'copy', path]);
  return { directory, scratch, source: await hashMediaFile(path),
    encoder: new ShortsRenditionEncodingService(scratch, new ShortsPackageService()) };
}

// Detect three independent audible/visible markers, not encoder argument strings.
function starts(values, threshold, sampleRate) {
  const result = []; let active = false;
  for (let i = 0; i < values.length; i++) {
    const next = values[i] > threshold;
    if (next && !active) result.push(i / sampleRate);
    active = next;
  }
  return result;
}
function aligned(actual, expected = events) {
  assert.equal(actual.length, expected.length, JSON.stringify(actual));
  for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= 0.08,
    `marker ${i}: ${actual[i]}s instead of ${expected[i]}s`);
}
async function audioMarkers(path) {
  const { stdout } = await command('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', path,
    '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' });
  const rms = [];
  for (let offset = 0; offset + 480 * 4 <= stdout.length; offset += 480 * 4) {
    let power = 0;
    for (let i = 0; i < 480; i++) power += stdout.readFloatLE(offset + i * 4) ** 2;
    rms.push(Math.sqrt(power / 480));
  }
  return starts(rms, 0.03, 100);
}
async function videoMarkers(path, rate) {
  const { stdout } = await command('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', path,
    '-map', '0:v:0', '-vf', 'scale=16:16', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  const brightness = [];
  for (let i = 0; i < stdout.length; i += 256)
    brightness.push(stdout.subarray(i, i + 256).reduce((sum, value) => sum + value, 0) / 256);
  return starts(brightness, 180, rate);
}

async function frameIdentities(path) {
  const { stdout } = await command('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', path,
    '-map', '0:v:0', '-vf', 'scale=16:1:flags=neighbor', '-pix_fmt', 'gray',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
  assert.equal(stdout.length % 16, 0);
  const ids = [];
  for (let i = 0; i < stdout.length; i += 16) {
    let id = 0;
    for (let bit = 0; bit < 16; bit++) {
      const value = stdout[i + bit];
      assert.ok(value < 64 || value > 192, 'frame counter must remain legible');
      if (value > 192) id += 2 ** bit;
    }
    ids.push(id);
  }
  return ids;
}

for (const [label, options] of [
  ['delayed audio', { audioOffset: 0.6 }],
  ['delayed video', { videoOffset: 0.6 }],
  ['both tracks starting late', { audioOffset: 0.6, videoOffset: 0.6 }],
  ['variable cadence', { vfr: true }],
  ['short audio', { audioEnd: 3.5 }],
  ['an audio timestamp gap', { audioGap: true }],
  ['a small audio timestamp gap', { audioGap: 0.07 }],
  ['stereo audio', { channels: 2 }],
  ['5.1 audio downmixed to stereo', { channels: 6 }],
]) test(`source-derived tracks preserve start/middle/end synchronization with ${label}`, { timeout: 120000 }, async t => {
  const f = await fixture(t, options), sourceProbe = await inspect(f.source.path);
  if (options.videoOffset) assert.ok(Math.abs(Number(sourceProbe.streams.find(s => s.codec_type === 'video').start_time) - options.videoOffset) < 0.001);
  if (options.audioOffset) assert.ok(Number(sourceProbe.streams.find(s => s.codec_type === 'audio').start_time) > 0.5);
  if (options.vfr) assert.notEqual(sourceProbe.streams[0].avg_frame_rate, sourceProbe.streams[0].r_frame_rate);
  await f.encoder.prepare(f.source, async output => {
    const duration = Number(sourceProbe.format.duration);
    for (const file of output.files.filter(file => /^(video.*\.mp4|audio.*\.m4a)$/.test(file.name))) {
      const media = await inspect(file.path);
      for (const stream of media.streams) {
        assert.ok(Math.abs(Number(stream.start_time)) <= 0.001, `${file.name} starts at ${stream.start_time}`);
        const rate = stream.codec_type === 'video'
          ? stream.avg_frame_rate.split('/').map(Number).reduce((n, d) => n / d) : 48000;
        assert.ok(Math.abs(Number(stream.duration) - duration) <= Math.max(1 / rate, 1024 / 48000) + 0.002,
          `${file.name} duration ${stream.duration} instead of ${duration}`);
        if (stream.codec_type === 'audio') {
          assert.equal(stream.channels, Math.min(options.channels || 1, 2));
          aligned(await audioMarkers(file.path));
        }
        else aligned(await videoMarkers(file.path, rate));
      }
      await command('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', file.path, '-f', 'null', '-']);
    }
  });
  assert.deepEqual(await hashMediaFile(f.source.path), f.source);
  assert.deepEqual(await readdir(f.scratch.directory), []);
});

test('supported CFR keeps every top-rendition frame; rotation and pixel aspect are applied once', { timeout: 120000 }, async t => {
  for (const options of [...['24000/1001', '24/1', '25/1', '30000/1001', '30/1', '48/1', '50/1', '60000/1001', '60/1'].map(fps => ({ fps, silent: true, counter: true })), { fps: '30000/1001', silent: true, rotate: true }]) {
    const f = await fixture(t, options), input = (await inspect(f.source.path)).streams[0];
    await f.encoder.prepare(f.source, async output => {
      const file = output.files.find(file => file.name === output.videos[0].name);
      const track = (await inspect(file.path)).streams[0];
      assert.equal(track.avg_frame_rate, options.fps);
      assert.equal(track.nb_read_frames, input.nb_read_frames);
      assert.equal(track.sample_aspect_ratio, '1:1');
      assert.ok(!track.side_data_list?.some(data => data.rotation));
      if (options.counter) {
        const expected = Array.from({ length: Number(input.nb_read_frames) }, (_, index) => index);
        assert.deepEqual(await frameIdentities(f.source.path), expected, 'source counter');
        assert.deepEqual(await frameIdentities(file.path), expected, `every ${options.fps} frame must survive in order`);
      }
      if (options.rotate) {
        assert.deepEqual([track.width, track.height], [180, 426]);
        assert.equal(output.probe.mediaType, 'video/quicktime');
        for (const path of [file.path, output.files.find(file => file.name === 'poster.jpg').path]) {
          const { stdout } = await command('ffmpeg', ['-nostdin', '-v', 'error', '-i', path,
            '-frames:v', '1', '-vf', 'scale=2:4', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
          assert.ok(stdout[1] > stdout[0] + 40, 'display top must be green');
          assert.ok(stdout[18] > stdout[19] + 40, 'display bottom must be red');
        }
      }
    });
    assert.deepEqual(await hashMediaFile(f.source.path), f.source);
  }
});

test('maximum-duration 60fps source preserves every decoded frame identity', { timeout: 120000 }, async t => {
  const f = await fixture(t, { silent: true, counter: true, duration: 60, fps: '60/1' });
  const expected = Array.from({ length: 3600 }, (_, index) => index);
  assert.deepEqual(await frameIdentities(f.source.path), expected);
  await f.encoder.prepare(f.source, async output => {
    const file = output.files.find(file => file.name === output.videos[0].name);
    assert.deepEqual(await frameIdentities(file.path), expected);
    const probe = (await inspect(file.path)).streams[0];
    assert.equal(Number(probe.duration), 60);
  });
  assert.deepEqual(await hashMediaFile(f.source.path), f.source);
});

test('API-encoded timeline markers survive the streaming service remux without changing encoded packets',
  { skip: !process.env.SHORTS_TEST_STREAMING_REPO, timeout: 180000 }, async t => {
    // Build the selected streaming checkout before enabling this cross-repository check.
    const { remuxAdaptive } = require(join(process.env.SHORTS_TEST_STREAMING_REPO, 'dist/streaming/adaptive-remux.js'));
    const packetHashes = async path => JSON.parse((await command('ffprobe', ['-v', 'error', '-show_packets',
      '-show_entries', 'packet=data_hash', '-show_data_hash', 'sha256', '-of', 'json', path])).stdout).packets.map(packet => packet.data_hash);
    for (const options of [{ audioOffset: 0.6 }, { videoOffset: 0.6 }, { audioOffset: 0.6, videoOffset: 0.6 }, { audioGap: true }, { audioGap: 0.07 }, { vfr: true }, { channels: 2 }, { channels: 6 }]) {
      const f = await fixture(t, options);
      await f.encoder.prepare(f.source, async output => {
        const inputs = output.files.filter(file => /^(video-.+\.mp4|audio-.+\.m4a)$/.test(file.name));
        const cid = await new ShortsPackageService().derivativeCid(inputs, 'inputs');
        const descriptor = { cid: output.originalCid, files: output.files,
          derivatives: { cid, videos: output.videos } };
        const directory = dirname(inputs[0].path);
        const prepared = await remuxAdaptive(descriptor, directory, AbortSignal.timeout(60000), 60000);
        assert.equal(prepared.version, 3);
        for (const input of inputs) {
          const audio = input.name.startsWith('audio-');
          const track = input.name.replace(audio ? 'audio-' : 'video-', audio ? 'a' : 'v').replace(/\.(m4a|mp4)$/, '');
          const path = join(directory, track + '.m3u8');
          assert.deepEqual(await packetHashes(path), await packetHashes(input.path), `${track} must be remuxed without encoding`);
          if (audio) {
            assert.equal((await inspect(path)).streams[0].channels, Math.min(options.channels || 1, 2));
            aligned(await audioMarkers(path));
          }
          else {
            const rate = output.videos.find(v => v.name === input.name).frameRate.split('/').map(Number).reduce((n, d) => n / d);
            aligned(await videoMarkers(path, rate));
          }
        }
      });
      assert.deepEqual(await hashMediaFile(f.source.path), f.source);
    }
  });

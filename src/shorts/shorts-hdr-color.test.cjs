require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ShortsScratchService, ShortsScratchProbeService } = require('./shorts-scratch.service');
const { ShortsRenditionEncodingService } = require('./shorts-rendition-encoding.service');
const { ShortsPackageService } = require('./shorts-package.service');
const { hashMediaFile } = require('./shorts-media-file');
const exec = promisify(execFile);
const ffmpeg = (args, options = {}) => exec('ffmpeg', ['-nostdin', '-v', 'error', '-filter_threads', '2', ...args],
  { timeout: 60000, maxBuffer: 1048576, ...options });

for (const transfer of ['smpte2084', 'arib-std-b67']) {
  const frameRate = transfer === 'smpte2084' ? 60 : 30;
  test(`${transfer} ${frameRate} fps source keeps neutral ordered tones in SDR renditions and its source poster`, { timeout: 120000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'shorts-hdr-color-'));
    const scratch = new ShortsScratchService({ directory: join(directory, 'work'), minFreeBytes: 64 * 1048576,
      minFreeInodes: 128, maxUsedPercent: Number(process.env.SHORTS_TEST_SCRATCH_MAX_USED_PERCENT || 85) }, new ShortsScratchProbeService());
    await scratch.onModuleInit();
    t.after(async () => { await scratch.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
    const path = join(directory, 'source.mp4');
    const pattern = `color=black:s=1920x1080:r=${frameRate}:d=2,drawbox=x=480:y=0:w=480:h=1080:color=0x404040:t=fill,` +
      'drawbox=x=960:y=0:w=480:h=1080:color=0x808080:t=fill,drawbox=x=1440:y=0:w=480:h=1080:color=white:t=fill';
    const convert = 'zscale=pin=bt709:tin=bt709:min=bt709:rin=tv:p=bt709:t=linear:m=gbr:r=full:npl=100,' +
      `format=gbrpf32le,zscale=p=bt2020,zscale=t=${transfer}:m=bt2020nc:r=tv:npl=400,format=yuv420p10le`;
    await ffmpeg(['-f', 'lavfi', '-i', pattern, '-vf', convert, '-c:v', 'libx265', '-preset', 'ultrafast', '-threads', '2',
      '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', transfer, '-colorspace', 'bt2020nc',
      '-x265-params', 'pools=2:frame-threads=2:log-level=error:repeat-headers=1:max-cll=400,200:' +
        'master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(4000000,50)', path]);
    const source = await hashMediaFile(path), packages = new ShortsPackageService();
    const input = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_frames', '-read_intervals', '%+0.2', '-of', 'json', path])).stdout);
    const sourceData = [...input.streams, ...input.frames].flatMap(item => item.side_data_list || []);
    assert.ok(sourceData.some(item => /Mastering display/i.test(item.side_data_type)));
    assert.ok(sourceData.some(item => /Content light level/i.test(item.side_data_type)));
    const cid = await packages.originalCid(source);
    await new ShortsRenditionEncodingService(scratch, packages).prepare(source, async output => {
      assert.equal(output.originalCid, cid); assert.equal(output.probe.hdr, true);
      assert.equal(output.videos.length, 5);
      for (const file of output.files.filter(file => /^video-.*\.mp4$/.test(file.name) || file.name === 'poster.jpg')) {
        const { stdout } = await ffmpeg(['-threads', '2', '-i', file.path, '-map', '0:v:0', '-an', '-vf', 'scale=64:36,format=rgb24',
          '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' });
        assert.equal(stdout.length, 64 * 36 * 3);
        const tones = [8, 24, 40, 56].map(x => [...stdout.subarray((18 * 64 + x) * 3, (18 * 64 + x) * 3 + 3)]);
        for (const rgb of tones) assert.ok(Math.max(...rgb) - Math.min(...rgb) <= 4, `${file.name}: neutral gray must remain neutral`);
        const light = tones.map(rgb => rgb.reduce((sum, channel) => sum + channel, 0) / 3);
        assert.ok(light[0] < 8 && light[3] > 180, `${file.name}: black and highlight range`);
        for (let index = 1; index < light.length; index++) assert.ok(light[index] - light[index - 1] > 20, `${file.name}: distinct ordered tones`);
        const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-threads', '2', '-count_frames', '-show_streams', '-show_frames', '-of', 'json', file.path],
          { maxBuffer: 4 * 1048576 })).stdout);
        for (const item of [...probe.streams, ...probe.frames]) {
          assert.ok(!(item.side_data_list || []).some(data => /Mastering display|Content light level|HDR|Ambient viewing/i.test(data.side_data_type)),
            `${file.name}: source HDR metadata must not survive SDR conversion`);
        }
        if (file.name.endsWith('.mp4')) {
          const video = probe.streams[0];
          assert.equal(video.color_transfer, 'bt709'); assert.equal(video.color_primaries, 'bt709'); assert.equal(video.color_space, 'bt709');
          const fps = file.name.includes('rescue') ? 15 : file.name.includes('1080') ? frameRate : Math.min(frameRate, 30);
          assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(Number(video.nb_read_frames), 2 * fps);
        }
      }
    });
    assert.deepEqual(await hashMediaFile(path), source);
    assert.deepEqual(await readdir(scratch.directory), []);
    assert.equal((await scratch.snapshot()).reservations, 0);
  });
}

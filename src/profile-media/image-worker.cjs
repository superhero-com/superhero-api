/* A short-lived decoder process; never receives wallet/storage credentials. */
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] });
const role = process.argv[2];
const chunks = [];
let bytes = 0;
process.stdin.on('data', (part) => {
  bytes += part.length;
  if (bytes > 10 * 1024 * 1024) process.exit(2);
  chunks.push(part);
});
process.stdin.on('end', async () => {
  try {
    if (!['avatar', 'cover', 'post'].includes(role)) throw new Error();
    const input = Buffer.concat(chunks);
    // Reject other containers before invoking a decoder.
    const jpeg = input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
    const png = input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const webp = input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
    if (!jpeg && !png && !webp) throw new Error();
    const options = { failOn: 'warning', limitInputPixels: 24000000, limitInputChannels: 4 };
    const info = await sharp(input, options).metadata();
    if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages || 1) !== 1 ||
        !info.width || !info.height || info.width > 8192 || info.height > 8192 ||
        info.width * info.height > 24000000 || Math.min(info.width, info.height) < (role === 'post' ? 32 : 128)) throw new Error();
    const width = role === 'post' ? 2048 : role === 'avatar' ? 1024 : 1920, height = role === 'post' ? 2048 : role === 'avatar' ? 1024 : 720;
    const rotated = [5, 6, 7, 8].includes(info.orientation);
    const scale = Math.min(1, (rotated ? info.height : info.width) / width, (rotated ? info.width : info.height) / height);
    const full = await sharp(input, options).rotate().resize(role === 'post' ? width : Math.floor(width * scale), role === 'post' ? height : Math.floor(height * scale), { fit: role === 'post' ? 'inside' : 'cover', withoutEnlargement: true })
      .toColourspace('srgb').webp({ quality: role === 'post' ? 84 : 88, effort: 3 }).timeout({ seconds: 8 }).toBuffer({ resolveWithObject: true });
    // Keep timeline payloads bounded even for detailed/noisy source photographs.
    let thumb;
    let previewSize = role === 'avatar' ? 128 : role === 'post' ? 640 : 480;
    for (const quality of [68, 58, 48, 40]) {
      thumb = await sharp(full.data, options).resize(previewSize, role === 'post' ? previewSize : undefined,
        { fit: 'inside', withoutEnlargement: true }).webp({ quality, effort: 3 }).timeout({ seconds: 2 }).toBuffer();
      if (thumb.length <= 48 * 1024) break;
      previewSize = Math.floor(previewSize * 0.8);
    }
    if (thumb.length > 48 * 1024) throw new Error();
    if (full.data.length + thumb.length > 3 * 1024 * 1024) throw new Error();
    process.stdout.write(JSON.stringify({ width: full.info.width, height: full.info.height,
      image: full.data.toString('base64'), thumb: thumb.toString('base64') }));
  } catch { process.exitCode = 2; }
});

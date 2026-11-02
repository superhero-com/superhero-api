import { createHash } from 'node:crypto';
import { SHORTS_POSTER_POLICY } from './shorts-poster';

export const SHORTS_ORIGINAL_PROFILE = 'original-h264-v1' as const;
export const SHORTS_RENDITION_MAX_BYTES = 192 * 1048576;
export interface ShortsVideoProbe {
  width: number;
  height: number;
  duration: number;
  frameRate: { numerator: number; denominator: number };
  audioChannels: number;
  hdr: boolean;
  colorFilter: string;
  mediaType: 'video/mp4' | 'video/quicktime';
}
export interface ShortsRendition {
  name: string;
  width: number;
  height: number;
  frameRate: string;
  crf: number;
  maxrate: string;
  bufsize: string;
  level: string;
}

export const SHORTS_HDR_LINEAR_FILTER =
  'zscale=t=linear:npl=100,format=gbrpf32le';

/** Tone-map already linearized HDR and remove source HDR display metadata. */
export function shortsHdrRenditionFilter(size?: {
  width: number;
  height: number;
}) {
  const resize = size
    ? `:w=${size.width}:h=${size.height}:f=bicubic:param_a=0:param_b=0.6`
    : '';
  return (
    `zscale=p=bt709${resize},tonemap=hable:desat=0,` +
    'zscale=t=bt709:m=bt709:r=tv,' +
    [
      'MASTERING_DISPLAY_METADATA',
      'CONTENT_LIGHT_LEVEL',
      'DYNAMIC_HDR_PLUS',
      'DYNAMIC_HDR_VIVID',
      'AMBIENT_VIEWING_ENVIRONMENT',
    ]
      .map((type) => `sidedata=mode=delete:type=${type}`)
      .join(',')
  );
}

/** Resize HDR in linear light before tone mapping at the delivery resolution. */
export function shortsHdrColorFilter(size?: { width: number; height: number }) {
  return `${SHORTS_HDR_LINEAR_FILTER},${shortsHdrRenditionFilter(size)}`;
}

export function shortsVideoProbe(value: any): ShortsVideoProbe {
  const video = value?.streams?.find((s: any) => s.codec_type === 'video');
  const audio = value?.streams?.find((s: any) => s.codec_type === 'audio');
  const duration = Number(value?.format?.duration);
  if (
    !video ||
    !['h264', 'hevc'].includes(video.codec_name) ||
    !Number.isInteger(video.width) ||
    !Number.isInteger(video.height) ||
    video.width < 2 ||
    video.height < 2 ||
    video.width > 8192 ||
    video.height > 8192 ||
    video.width * video.height > 3840 * 2160 ||
    !Number.isFinite(duration) ||
    duration < 2 ||
    duration > 60 ||
    !String(value?.format?.format_name).split(',').includes('mov') ||
    (audio &&
      (!Number.isInteger(audio.channels) ||
        audio.channels < 1 ||
        audio.channels > 8))
  )
    throw new Error(
      'Choose a supported H.264/HEVC MP4 or MOV, 2–60 seconds, up to 4K',
    );
  if (
    video.side_data_list?.some((s: any) =>
      /DOVI|Dolby Vision/i.test(s.side_data_type),
    )
  )
    throw new Error('This Dolby Vision profile is not supported yet');
  const rate = /^(\d{1,7})\/(\d{1,7})$/.exec(video.avg_frame_rate || '');
  let numerator = Number(rate?.[1]),
    denominator = Number(rate?.[2]);
  if (
    !numerator ||
    !denominator ||
    numerator / denominator < 1 ||
    numerator / denominator > 240
  )
    throw new Error('Unsupported video frame rate');
  if (numerator / denominator > 60) {
    numerator = 60;
    denominator = 1;
  }
  const sar = /^(\d{1,5}):(\d{1,5})$/.exec(video.sample_aspect_ratio || '1:1');
  const aspect =
    sar && Number(sar[1]) && Number(sar[2])
      ? Number(sar[1]) / Number(sar[2])
      : 1;
  if (aspect < 0.25 || aspect > 4)
    throw new Error('Unsupported video pixel aspect ratio');
  let width = video.width * aspect,
    height = video.height;
  const rotation = Number(
    video.side_data_list?.find((s: any) => s.rotation !== undefined)
      ?.rotation || 0,
  );
  if (!Number.isFinite(rotation) || rotation % 90 !== 0)
    throw new Error('Unsupported video rotation');
  if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
  const hdr = ['smpte2084', 'arib-std-b67'].includes(video.color_transfer);
  if (
    hdr &&
    (video.color_primaries !== 'bt2020' ||
      !['bt2020nc', 'bt2020c'].includes(video.color_space))
  )
    throw new Error('Unsupported HDR color metadata');
  let colorFilter = shortsHdrColorFilter();
  if (!hdr) {
    const inferred =
      video.width >= 1280 || video.height > 576 ? 'bt709' : 'smpte170m';
    colorFilter = `colorspace=all=bt709:iall=${inferred}:range=tv`;
    for (const [field, option, values] of [
      [
        'color_space',
        'ispace',
        ['bt709', 'bt470bg', 'smpte170m', 'smpte240m', 'bt2020nc'],
      ],
      [
        'color_primaries',
        'iprimaries',
        ['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'bt2020'],
      ],
      [
        'color_transfer',
        'itrc',
        [
          'bt709',
          'gamma22',
          'gamma28',
          'smpte170m',
          'smpte240m',
          'iec61966-2-1',
          'bt2020-10',
          'bt2020-12',
        ],
      ],
    ] as const) {
      const value = video[field];
      if (!value || ['unknown', 'unspecified'].includes(value)) continue;
      if (!(values as readonly string[]).includes(value))
        throw new Error('Unsupported SDR color metadata');
      colorFilter += `:${option}=${value}`;
    }
    if (['tv', 'pc'].includes(video.color_range))
      colorFilter += `:irange=${video.color_range}`;
  }
  return {
    width,
    height,
    duration,
    frameRate: { numerator, denominator },
    audioChannels: audio ? Math.min(audio.channels, 2) : 0,
    hdr,
    colorFilter,
    mediaType:
      String(value.format.tags?.major_brand || '').trim() === 'qt'
        ? 'video/quicktime'
        : 'video/mp4',
  };
}

export function shortsRenditions(probe: ShortsVideoProbe): ShortsRendition[] {
  const { numerator, denominator } = probe.frameRate;
  const fps = numerator / denominator;
  const seen = new Set<string>();
  const variants: ShortsRendition[] = [];
  for (const tier of [1080, 720, 480, 360, 144]) {
    const portrait = probe.height >= probe.width;
    const boxWidth = portrait ? tier : (tier * 16) / 9;
    const boxHeight = portrait ? (tier * 16) / 9 : tier;
    const ratio = Math.min(1, boxWidth / probe.width, boxHeight / probe.height);
    const width = Math.max(2, 2 * Math.floor((probe.width * ratio) / 2));
    const height = Math.max(2, 2 * Math.floor((probe.height * ratio) / 2));
    // Native-sized small videos need only one normal rendition, plus rescue.
    const dimensions = `${width}x${height}`;
    if (seen.has(dimensions) && tier !== 144) continue;
    seen.add(dimensions);
    const divisor =
      tier === 144 ? Math.ceil(fps / 15) : tier < 1080 && fps > 30 ? 2 : 1;
    variants.push({
      name: tier === 144 ? 'video-rescue.mp4' : `video-${tier}.mp4`,
      width,
      height,
      frameRate: `${numerator}/${denominator * divisor}`,
      crf: tier === 1080 ? 20 : tier === 360 ? 26 : tier === 144 ? 30 : 23,
      maxrate:
        tier === 1080
          ? fps > 30
            ? '12M'
            : '8M'
          : tier === 720
            ? '3M'
            : tier === 480
              ? '1500k'
              : tier === 360
                ? '500k'
                : '100k',
      bufsize:
        tier === 1080
          ? fps > 30
            ? '24M'
            : '16M'
          : tier === 720
            ? '6M'
            : tier === 480
              ? '3M'
              : tier === 360
                ? '1M'
                : '100k',
      level:
        tier === 1080
          ? fps > 30
            ? '4.2'
            : '4.1'
          : tier >= 480
            ? '3.1'
            : tier === 360
              ? '3.0'
              : '2.0',
    });
  }
  return variants;
}

export const SHORTS_RENDITION_POLICY = {
  profile: SHORTS_ORIGINAL_PROFILE,
  revision: 7,
  video: 'x264-medium-yuv420p-high-2s-gop-crf20-23-23-26-30-vbv',
  audio: 'aac-lc-48khz-main192k-rescue48k-matched-mono-or-stereo',
  timeline:
    'container-zero-cfr-average-bounded60-hold-boundary-frames-audio-gap-silence-trim',
  hdr: 'zscale-linear-grouped-lower-cadence-before-bicubic-hable-bt709-strip-hdr-side-data',
  sdr: 'colorspace-bt709-infer-hd709-sd170m-explicit-x264-vui',
  poster: SHORTS_POSTER_POLICY,
} as const;
export const SHORTS_RENDITION_POLICY_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(SHORTS_RENDITION_POLICY))
  .digest('hex');

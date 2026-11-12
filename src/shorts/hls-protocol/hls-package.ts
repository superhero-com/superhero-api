// Playback wire protocol; mirrored by superhero-video-streaming with shared compatibility vectors.
import { createHash } from 'node:crypto';
import { PlaybackDescriptor } from './playback-descriptor';
import { adaptiveAssets, parseMaster, trackBandwidth } from './hls-adaptive';
import {
  adaptiveSourceIdentity,
  deliverySourceIdentity,
  derivativeLimit,
} from './playback-descriptor';

export interface HlsPackage {
  version: 3;
  cid: string;
  playlist: string;
  playlists: Record<string, string>;
  files: { name: string; bytes: number; sha256: string }[];
}
export function sourceKey(descriptor: PlaybackDescriptor) {
  return createHash('sha256')
    .update(`hls-v3\n${adaptiveSourceIdentity(descriptor)}`)
    .digest('hex');
}
export function validatePackage(value: HlsPackage): HlsPackage {
  if (
    !value ||
    value.version !== 3 ||
    !Array.isArray(value.files) ||
    value.files.length > 256
  )
    throw new Error('Invalid HLS package version');
  const assets = adaptiveAssets(value.playlist, value.playlists);
  if (
    !/^b[a-z2-7]{20,118}$/.test(value.cid) ||
    value.files.length !== assets.length ||
    new Set(value.files.map((f) => f.name)).size !== assets.length ||
    value.files.some(
      (f) =>
        !assets.includes(f.name) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 1 ||
        f.bytes > 100_000_000 ||
        !/^[a-f0-9]{64}$/.test(f.sha256),
    ) ||
    value.files.reduce((sum, f) => sum + f.bytes, 0) > derivativeLimit
  )
    throw new Error('Invalid prepared package');
  for (const [name, playlist] of Object.entries({
    'index.m3u8': value.playlist,
    ...value.playlists,
  })) {
    const manifest = value.files.find((f) => f.name === name)!;
    if (
      manifest.bytes !== Buffer.byteLength(playlist) ||
      manifest.sha256 !== createHash('sha256').update(playlist).digest('hex')
    )
      throw new Error('Invalid playlist integrity');
  }
  if (value.version === 3) {
    for (const video of parseMaster(value.playlist).videos) {
      const measured = trackBandwidth(
        value.playlists![`${video.track}.m3u8`],
        value.files,
        video.track,
      );
      const audio = video.audio
        ? trackBandwidth(
            value.playlists![`${video.audio}.m3u8`],
            value.files,
            video.audio,
          )
        : { peak: 0, average: 0 };
      if (
        video.bandwidth !== measured.peak + audio.peak ||
        video.averageBandwidth !== measured.average + audio.average
      )
        throw new Error('Invalid measured HLS bandwidth');
    }
  }
  return value;
}

/** Bind a recoverable index to the exact prepared ladder and strip non-protocol fields. */
export function validateSourcePackage(
  descriptor: PlaybackDescriptor,
  value: HlsPackage,
): HlsPackage {
  deliverySourceIdentity(descriptor);
  validatePackage(value);
  if (
    value.version !== 3 ||
    Buffer.byteLength(JSON.stringify(value)) > 131072 ||
    [
      descriptor.cid,
      descriptor.derivatives!.cid,
      descriptor.derivatives!.assetsCid,
    ].includes(value.cid)
  )
    throw new Error('Invalid original delivery package');
  const master = parseMaster(value.playlist),
    videos = descriptor.derivatives!.videos;
  const audio = descriptor.files.some((file) => file.name === 'audio-main.m4a');
  if (
    master.videos.length !== videos.length ||
    master.audio.length !== (audio ? 2 : 0) ||
    master.videos.some((video) => {
      const source = videos.find(
        (item) => item.name === `video-${video.track.slice(1)}.mp4`,
      );
      const [numerator, denominator] =
        source?.frameRate.split('/').map(Number) || [];
      return (
        !source ||
        source.width !== video.width ||
        source.height !== video.height ||
        Number((numerator / denominator).toFixed(3)) !== video.frameRate ||
        video.audio !==
          (audio
            ? video.track === 'vrescue'
              ? 'arescue'
              : 'amain'
            : undefined)
      );
    })
  )
    throw new Error('Delivery ladder differs from prepared source');
  return {
    version: 3,
    cid: value.cid,
    playlist: value.playlist,
    playlists: Object.fromEntries(
      Object.entries(value.playlists!).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
    files: value.files
      .map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

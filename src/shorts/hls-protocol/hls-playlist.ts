// Playback wire protocol; mirrored by superhero-video-streaming with shared compatibility vectors.
export const videoTracks = [
  'v1080',
  'v720',
  'v480',
  'v360',
  'vrescue',
] as const;
export const audioTracks = ['amain', 'arescue'] as const;
export type VideoTrack = (typeof videoTracks)[number];
export type AudioTrack = (typeof audioTracks)[number];
export type Track = VideoTrack | AudioTrack;
const trackPattern = '(?:v(?:1080|720|480|360|rescue)|a(?:main|rescue))';
export function trackPlaylistName(name: string) {
  return new RegExp(`^${trackPattern}\\.m3u8$`).test(name);
}
export function segmentName(name: string) {
  return new RegExp(`^(?:${trackPattern}-)?segment-\\d{3}\\.m4s$`).test(name);
}
export function initName(name: string) {
  return new RegExp(`^(?:${trackPattern}-)?init\\.mp4$`).test(name);
}
export function hlsName(name: string) {
  return (
    name === 'index.m3u8' ||
    trackPlaylistName(name) ||
    initName(name) ||
    segmentName(name)
  );
}

export interface MediaPlaylist {
  init: string;
  assets: string[];
  duration: number;
  target: number;
  segments: { name: string; duration: number; start: number }[];
}
/** Only bounded, local VOD tracks are accepted. No external URLs, keys or byte ranges. */
export function mediaPlaylist(
  playlist: string,
  expected?: Track,
): MediaPlaylist {
  if (
    typeof playlist !== 'string' ||
    Buffer.byteLength(playlist) > 16384 ||
    !playlist.startsWith('#EXTM3U\n')
  )
    throw new Error('Invalid HLS playlist');
  const names = new Set<string>(),
    tags = new Set<string>();
  const segments: MediaPlaylist['segments'] = [];
  let duration = 0,
    pending = 0,
    ended = false,
    init = '',
    target = 0;
  for (const line of playlist.trimEnd().split('\n').slice(1)) {
    if (ended) throw new Error('Invalid HLS end');
    if (line === '#EXT-X-ENDLIST') {
      ended = true;
      continue;
    }
    const map = /^#EXT-X-MAP:URI="([^"]+)"$/.exec(line);
    if (map) {
      if (
        init ||
        !initName(map[1]) ||
        (expected && map[1] !== `${expected}-init.mp4`)
      )
        throw new Error('Invalid HLS init');
      init = map[1];
      names.add(init);
      continue;
    }
    if (/^#EXTINF:\d+(?:\.\d+)?,(?:\s*)$/.test(line)) {
      if (pending) throw new Error('Missing HLS segment');
      pending = Number(line.slice(8).split(',')[0]);
      if (pending <= 0 || pending > 4.1)
        throw new Error('Invalid HLS segment duration');
      continue;
    }
    if (segmentName(line)) {
      const prefix = init.replace(/init\.mp4$/, '');
      if (
        !init ||
        !pending ||
        names.has(line) ||
        line !==
          `${prefix}segment-${String(segments.length).padStart(3, '0')}.m4s`
      )
        throw new Error('Invalid HLS segment');
      names.add(line);
      segments.push({ name: line, duration: pending, start: duration });
      duration += pending;
      pending = 0;
      continue;
    }
    if (
      !/^(#EXT-X-VERSION:7|#EXT-X-TARGETDURATION:[1-4]|#EXT-X-MEDIA-SEQUENCE:0|#EXT-X-PLAYLIST-TYPE:VOD|#EXT-X-INDEPENDENT-SEGMENTS)$/.test(
        line,
      ) ||
      tags.has(line.split(':')[0])
    )
      throw new Error('Unsupported HLS playlist entry');
    tags.add(line.split(':')[0]);
    if (line.startsWith('#EXT-X-TARGETDURATION:'))
      target = Number(line.split(':')[1]);
  }
  if (
    !ended ||
    !init ||
    pending ||
    duration <= 0 ||
    duration > 61 ||
    names.size < 2 ||
    names.size > 33 ||
    (target &&
      segments.some((segment) => Math.round(segment.duration) > target)) ||
    (expected &&
      (!target ||
        ![
          '#EXT-X-VERSION',
          '#EXT-X-MEDIA-SEQUENCE',
          '#EXT-X-PLAYLIST-TYPE',
        ].every((tag) => tags.has(tag))))
  )
    throw new Error('Incomplete HLS playlist');
  return { init, assets: [...names], segments, duration, target: target || 2 };
}
export function playlistAssets(playlist: string) {
  return mediaPlaylist(playlist).assets;
}

export function signedPlaylist(playlist: string, token: string) {
  const media = mediaPlaylist(playlist),
    query = `?token=${encodeURIComponent(token)}`;
  return playlist
    .split('\n')
    .map((line) => {
      if (line === `#EXT-X-MAP:URI="${media.init}"`)
        return `#EXT-X-MAP:URI="${media.init}${query}"`;
      return segmentName(line) ? `${line}${query}` : line;
    })
    .join('\n');
}

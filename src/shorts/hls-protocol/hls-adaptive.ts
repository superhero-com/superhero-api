// Playback wire protocol; mirrored by superhero-video-streaming with shared compatibility vectors.
import {
  AudioTrack,
  Track,
  VideoTrack,
  audioTracks,
  mediaPlaylist,
  videoTracks,
} from './hls-playlist';

export interface AdaptiveVariant {
  track: VideoTrack;
  bandwidth: number;
  averageBandwidth: number;
  codec: string;
  width: number;
  height: number;
  frameRate: number;
  audio?: AudioTrack;
}
export interface AdaptiveAudio {
  track: AudioTrack;
  channels: number;
}
export interface AdaptiveMaster {
  videos: AdaptiveVariant[];
  audio: AdaptiveAudio[];
}

export function masterPlaylist(value: AdaptiveMaster) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const audio of value.audio)
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audio.track}",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="${audio.channels}",URI="${audio.track}.m3u8"`,
    );
  for (const video of value.videos)
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${video.bandwidth},AVERAGE-BANDWIDTH=${video.averageBandwidth},CODECS="${video.codec}${video.audio ? ',mp4a.40.2' : ''}",RESOLUTION=${video.width}x${video.height},FRAME-RATE=${video.frameRate.toFixed(3)}${video.audio ? `,AUDIO="${video.audio}"` : ''}`,
      `${video.track}.m3u8`,
    );
  const playlist = lines.join('\n') + '\n';
  parseMaster(playlist);
  return playlist;
}

/** A small closed master grammar prevents arbitrary URIs or unreferenced tracks. */
export function parseMaster(playlist: string): AdaptiveMaster {
  if (
    typeof playlist !== 'string' ||
    Buffer.byteLength(playlist) > 16384 ||
    !playlist.startsWith(
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n',
    )
  )
    throw new Error('Invalid HLS master');
  const lines = playlist.trimEnd().split('\n').slice(3),
    videos: AdaptiveVariant[] = [],
    audio: AdaptiveAudio[] = [];
  const names = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const sound =
      /^#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="(amain|arescue)",NAME="Original",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="([12])",URI="(amain|arescue)\.m3u8"$/.exec(
        lines[index],
      );
    if (sound) {
      if (videos.length || sound[1] !== sound[3] || names.has(sound[1]))
        throw new Error('Invalid HLS audio group');
      names.add(sound[1]);
      audio.push({ track: sound[1] as AudioTrack, channels: Number(sound[2]) });
      continue;
    }
    const stream =
      /^#EXT-X-STREAM-INF:BANDWIDTH=(\d{1,8}),AVERAGE-BANDWIDTH=(\d{1,8}),CODECS="(avc1\.[a-f0-9]{6})(,mp4a\.40\.2)?",RESOLUTION=(\d{1,4})x(\d{1,4}),FRAME-RATE=(\d{1,2}\.\d{3})(?:,AUDIO="(amain|arescue)")?$/.exec(
        lines[index],
      );
    const track = /^(v1080|v720|v480|v360|vrescue)\.m3u8$/.exec(
      lines[++index] || '',
    )?.[1] as VideoTrack | undefined;
    if (!stream || !track || names.has(track))
      throw new Error('Invalid HLS variant');
    const bandwidth = Number(stream[1]),
      averageBandwidth = Number(stream[2]),
      width = Number(stream[5]),
      height = Number(stream[6]),
      frameRate = Number(stream[7]);
    if (
      bandwidth < 1 ||
      bandwidth > 30_000_000 ||
      averageBandwidth < 1 ||
      averageBandwidth > bandwidth ||
      width < 2 ||
      height < 2 ||
      width > 1920 ||
      height > 1920 ||
      width % 2 ||
      height % 2 ||
      width * height > 2073600 ||
      frameRate < 1 ||
      frameRate > 60 ||
      !!stream[4] !== !!stream[8] ||
      (!!stream[8] && !names.has(stream[8])) ||
      (track === 'vrescue' &&
        (bandwidth > 192000 || (!!stream[8] && stream[8] !== 'arescue'))) ||
      (track !== 'vrescue' && !!stream[8] && stream[8] !== 'amain')
    )
      throw new Error('Invalid HLS variant attributes');
    names.add(track);
    videos.push({
      track,
      bandwidth,
      averageBandwidth,
      width,
      height,
      frameRate,
      codec: stream[3],
      ...(stream[8] ? { audio: stream[8] as AudioTrack } : {}),
    });
  }
  if (
    videos.length < 2 ||
    videos.length > videoTracks.length ||
    !videos.some((video) => video.track === 'vrescue') ||
    (audio.length !== 0 &&
      (audio.length !== audioTracks.length ||
        !audioTracks.every((track) => names.has(track)))) ||
    videos.some((video) => !!video.audio !== !!audio.length)
  )
    throw new Error('Incomplete HLS master');
  return { videos, audio };
}

export function adaptiveAssets(
  playlist: string,
  playlists: Record<string, string>,
) {
  const master = parseMaster(playlist);
  const tracks: Track[] = [
    ...master.videos.map((video) => video.track),
    ...master.audio.map((audio) => audio.track),
  ];
  if (
    !playlists ||
    typeof playlists !== 'object' ||
    Array.isArray(playlists) ||
    Object.keys(playlists).length !== tracks.length ||
    Object.keys(playlists).some(
      (name) => !tracks.some((track) => name === `${track}.m3u8`),
    )
  )
    throw new Error('Incomplete HLS track graph');
  const assets = ['index.m3u8'];
  const reference = mediaPlaylist(
    playlists[`${master.videos[0].track}.m3u8`],
    master.videos[0].track,
  );
  for (const track of tracks) {
    const media = mediaPlaylist(playlists[`${track}.m3u8`], track);
    const cadence = track.startsWith('v')
      ? 1 / master.videos.find((video) => video.track === track)!.frameRate +
        0.005
      : 0.05;
    if (
      media.target !== 2 ||
      media.segments.some(
        (segment, index) =>
          segment.duration > 2 + cadence ||
          (index < media.segments.length - 1 && segment.duration < 2 - cadence),
      )
    )
      throw new Error('Invalid adaptive segment cadence');
    assets.push(`${track}.m3u8`, ...media.assets);
    if (track.startsWith('v')) {
      const fps = master.videos.find(
        (video) => video.track === track,
      )!.frameRate;
      const tolerance =
        Math.max(1 / fps, 1 / master.videos[0].frameRate) + 0.005;
      if (
        media.segments.length !== reference.segments.length ||
        Math.abs(media.duration - reference.duration) > tolerance ||
        media.segments.some(
          (segment, index) =>
            Math.abs(segment.start - reference.segments[index].start) >
            tolerance,
        )
      )
        throw new Error('Unaligned HLS video tracks');
    } else if (Math.abs(media.duration - reference.duration) > 0.15)
      throw new Error('Unaligned HLS audio duration');
  }
  if (assets.length > 256 || new Set(assets).size !== assets.length)
    throw new Error('Invalid HLS graph size');
  return assets;
}

export function signedMaster(playlist: string, token: string) {
  parseMaster(playlist);
  const query = `?token=${encodeURIComponent(token)}`;
  return playlist
    .split('\n')
    .map((line) =>
      line.startsWith('#EXT-X-MEDIA:')
        ? line.replace(/URI="([^"]+)"$/, `URI="$1${query}"`)
        : /^(?:v1080|v720|v480|v360|vrescue)\.m3u8$/.test(line)
          ? line + query
          : line,
    )
    .join('\n');
}

/** RFC 8216 section 4.1: complete segment bytes over the prescribed peak windows.
 * Keep conservative startup overhead separate from the declared HLS bandwidth. */
export function trackBandwidth(
  playlist: string,
  files: { name: string; bytes: number }[],
  track: Track,
) {
  const media = mediaPlaylist(playlist, track),
    sizes = new Map(files.map((file) => [file.name, file.bytes]));
  const init = sizes.get(media.init);
  if (!init || media.segments.some((segment) => !sizes.get(segment.name)))
    throw new Error('Missing bandwidth sample');
  const average =
    (8 *
      media.segments.reduce(
        (sum, segment) => sum + sizes.get(segment.name)!,
        0,
      )) /
    media.duration;
  let peak = 0,
    budgetPeak = average + (8 * init) / media.duration;
  for (let start = 0; start < media.segments.length; start++) {
    let bytes = 0,
      seconds = 0;
    for (let end = start; end < media.segments.length; end++) {
      seconds += media.segments[end].duration;
      bytes += sizes.get(media.segments[end].name)!;
      if (seconds > 1.5 * media.target) break;
      if (seconds >= 0.5 * media.target) {
        peak = Math.max(peak, (8 * bytes) / seconds);
        budgetPeak = Math.max(budgetPeak, (8 * (bytes + init)) / seconds);
      }
    }
  }
  if (!peak) throw new Error('Missing HLS bandwidth window');
  return {
    peak: Math.ceil(peak),
    average: Math.ceil(average),
    budgetPeak: Math.ceil(budgetPeak * 1.05),
  };
}

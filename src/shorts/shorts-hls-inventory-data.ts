import { createHash } from 'node:crypto';

export interface HlsIndexObservation {
  sourceKey: string;
  cid: string;
  hash: string;
  bytes: number;
  files: { name: string; bytes: number; sha256: string }[];
}
const cidPattern = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,118})$/;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** hls-v2 source identity shared with the streaming service's sourceKey protocol. */
export function hlsSourceKey(source: any): string {
  if (
    !source ||
    typeof source.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) ||
    !cidPattern.test(source.cid) ||
    source.file?.name !== 'video.mp4' ||
    !/^[a-f0-9]{64}$/.test(source.file.sha256) ||
    !Number.isSafeInteger(source.file.bytes) ||
    source.file.bytes < 1 ||
    source.file.bytes > 100000000
  )
    throw new Error('Invalid HLS source reference');
  return sha(
    `hls-v2\n${source.id}\n${source.cid}\n${source.file.sha256}\n${source.file.bytes}`,
  );
}

/** Decode the stored index protocol only; no playback permission or media integrity claim. */
export function hlsObservation(
  sourceKey: string,
  raw: string,
): HlsIndexObservation {
  if (
    !/^[a-f0-9]{64}$/.test(sourceKey) ||
    typeof raw !== 'string' ||
    Buffer.byteLength(raw) > 32768
  )
    throw new Error('Invalid HLS index observation');
  const value = JSON.parse(raw);
  if (
    !value ||
    !cidPattern.test(value.cid) ||
    typeof value.playlist !== 'string' ||
    Buffer.byteLength(value.playlist) > 16384 ||
    !value.playlist.startsWith('#EXTM3U\n') ||
    !Array.isArray(value.files) ||
    value.files.length < 3 ||
    value.files.length > 34
  )
    throw new Error('Invalid HLS index metadata');
  // The index contains one rendition, a VOD playlist, init and at most 32 segments.
  const names = new Set<string>();
  let duration = 0,
    mapped = false,
    ended = false,
    pending = false;
  for (const line of value.playlist.trimEnd().split('\n').slice(1)) {
    if (ended) throw new Error('Invalid HLS end');
    if (line === '#EXT-X-ENDLIST') {
      ended = true;
      continue;
    }
    if (line === '#EXT-X-MAP:URI="init.mp4"') {
      if (mapped) throw new Error('Invalid HLS init');
      mapped = true;
      names.add('init.mp4');
      continue;
    }
    if (/^#EXTINF:\d+(?:\.\d+)?,(?:\s*)$/.test(line)) {
      const seconds = Number(line.slice(8).split(',')[0]);
      if (pending || seconds <= 0 || seconds > 4.1)
        throw new Error('Invalid HLS duration');
      duration += seconds;
      pending = true;
      continue;
    }
    if (/^segment-\d{3}\.m4s$/.test(line)) {
      if (!mapped || !pending || names.has(line))
        throw new Error('Invalid HLS segment');
      names.add(line);
      pending = false;
      continue;
    }
    if (
      !/^(#EXT-X-VERSION:7|#EXT-X-TARGETDURATION:[1-4]|#EXT-X-MEDIA-SEQUENCE:0|#EXT-X-PLAYLIST-TYPE:VOD|#EXT-X-INDEPENDENT-SEGMENTS)$/.test(
        line,
      )
    )
      throw new Error('Unsupported HLS index playlist');
  }
  if (
    !ended ||
    !mapped ||
    pending ||
    duration <= 0 ||
    duration > 61 ||
    names.size < 2 ||
    names.size > 33
  )
    throw new Error('Incomplete HLS index');
  names.add('index.m3u8');
  const files = value.files.map((file: any) => {
    if (
      !file ||
      !names.delete(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 100000000 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid HLS file metadata');
    return {
      name: file.name as string,
      bytes: file.bytes as number,
      sha256: file.sha256 as string,
    };
  });
  const bytes = files.reduce((total, file) => total + file.bytes, 0),
    manifest = files.find((file) => file.name === 'index.m3u8');
  if (
    names.size ||
    bytes > 100000000 ||
    !manifest ||
    manifest.bytes !== Buffer.byteLength(value.playlist) ||
    manifest.sha256 !== sha(value.playlist)
  )
    throw new Error('Invalid HLS index integrity');
  return { sourceKey, cid: value.cid, hash: sha(raw), bytes, files };
}

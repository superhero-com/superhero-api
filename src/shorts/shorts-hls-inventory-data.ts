import { createHash } from 'node:crypto';
import {
  sourceKey as playbackSourceKey,
  validatePackage,
} from './hls-protocol/hls-package';

export interface HlsIndexObservation {
  version: 2 | 3;
  sourceKey: string;
  cid: string;
  hash: string;
  bytes: number;
  files: { name: string; bytes: number; sha256: string }[];
}
const cidPattern = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,118})$/;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Keep legacy hls-v2 keys stable; new descriptors use the scoped hls-v3 identity. */
export function hlsSourceKey(source: any): string {
  if (source?.original !== undefined || source?.derivatives !== undefined)
    return playbackSourceKey(source);
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
  return playbackSourceKey({
    id: source.id,
    cid: source.cid,
    files: [source.file],
  });
}

/** Decode a bounded stored-index protocol; this is not permission to serve or delete media. */
export function hlsObservation(
  sourceKey: string,
  raw: string,
): HlsIndexObservation {
  if (
    !/^[a-f0-9]{64}$/.test(sourceKey) ||
    typeof raw !== 'string' ||
    Buffer.byteLength(raw) > 131072
  )
    throw new Error('Invalid HLS index observation');
  const value = JSON.parse(raw);
  if (value?.version !== 3 && Buffer.byteLength(raw) > 32768)
    throw new Error('Legacy HLS index too large');
  const prepared = validatePackage(value);
  const files = prepared.files.map(({ name, bytes, sha256 }) => ({
    name,
    bytes,
    sha256,
  }));
  return {
    version: prepared.version === 3 ? 3 : 2,
    sourceKey,
    cid: prepared.cid,
    hash: sha(raw),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

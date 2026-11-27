import { createHash } from 'node:crypto';
import {
  sourceKey as playbackSourceKey,
  validatePackage,
} from './hls-protocol/hls-package';

export interface HlsIndexObservation {
  version: 3;
  sourceKey: string;
  cid: string;
  hash: string;
  bytes: number;
  files: { name: string; bytes: number; sha256: string }[];
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export const hlsSourceKey = playbackSourceKey;

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
  const prepared = validatePackage(value);
  const files = prepared.files.map(({ name, bytes, sha256 }) => ({
    name,
    bytes,
    sha256,
  }));
  return {
    version: prepared.version,
    sourceKey,
    cid: prepared.cid,
    hash: sha(raw),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

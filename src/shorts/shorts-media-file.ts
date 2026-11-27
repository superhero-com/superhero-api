import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** A verified instance-owned scratch file. Never accept paths from a client. */
export interface ShortsMediaFile {
  path: string;
  bytes: number;
  sha256: string;
}

export const SHORTS_ORIGINAL_HARD_LIMIT = 100_000_000;

export function validateMediaIdentity(
  value: Pick<ShortsMediaFile, 'bytes' | 'sha256'>,
  maxBytes = SHORTS_ORIGINAL_HARD_LIMIT,
) {
  if (
    !value ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > maxBytes ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error('Invalid media file identity');
}

/** Verify length and checksum while consuming, before a caller publishes output. */
export async function* verifiedMediaBytes(
  input: AsyncIterable<Uint8Array>,
  identity: Pick<ShortsMediaFile, 'bytes' | 'sha256'>,
  signal?: AbortSignal,
) {
  validateMediaIdentity(identity);
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of input) {
    signal?.throwIfAborted();
    if (!(chunk instanceof Uint8Array))
      throw new Error('Invalid media byte stream');
    bytes += chunk.byteLength;
    if (bytes > identity.bytes) throw new Error('Media file length mismatch');
    hash.update(chunk);
    yield chunk;
  }
  signal?.throwIfAborted();
  if (bytes !== identity.bytes || hash.digest('hex') !== identity.sha256)
    throw new Error('Media file integrity mismatch');
}

export async function hashMediaFile(
  path: string,
  signal?: AbortSignal,
): Promise<ShortsMediaFile> {
  signal?.throwIfAborted();
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > SHORTS_ORIGINAL_HARD_LIMIT)
    throw new Error('Invalid media file size');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    bytes += chunk.length;
    if (bytes > info.size) throw new Error('Media file changed during read');
    hash.update(chunk);
  }
  signal?.throwIfAborted();
  if (bytes !== info.size) throw new Error('Media file changed during read');
  return { path, bytes, sha256: hash.digest('hex') };
}

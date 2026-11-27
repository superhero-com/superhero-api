import type { FileHandle } from 'node:fs/promises';
import { SHORTS_UPLOAD_PART_BYTES } from './shorts-upload-policy';

export async function readOriginalPart(
  handle: FileHandle,
  size: number,
  index: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const start = index * SHORTS_UPLOAD_PART_BYTES;
  const part = Buffer.alloc(Math.min(SHORTS_UPLOAD_PART_BYTES, size - start));
  let offset = 0;
  while (offset < part.length) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(
      part,
      offset,
      part.length - offset,
      start + offset,
    );
    if (!bytesRead) throw new Error('Verified original changed during staging');
    offset += bytesRead;
  }
  return part;
}

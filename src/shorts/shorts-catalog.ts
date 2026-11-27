import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface CatalogPosition {
  at: number;
  id: string;
}

export const CATALOG_PAGE_SIZE = 20;

/** A cursor is an untrusted query position, never a grant to read private content. */
export function catalogCursor(scope: unknown[], cursor?: string) {
  const binding = createHash('sha256')
    .update(JSON.stringify(scope))
    .digest('hex');
  const encode = (position: CatalogPosition) =>
    Buffer.from(JSON.stringify({ v: 1, binding, ...position })).toString(
      'base64url',
    );
  let after: CatalogPosition | undefined;
  if (cursor !== undefined) {
    try {
      if (
        typeof cursor !== 'string' ||
        cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(cursor)
      )
        throw new Error();
      const decoded = Buffer.from(cursor, 'base64url');
      if (decoded.toString('base64url') !== cursor) throw new Error();
      const value = JSON.parse(decoded.toString('utf8'));
      if (
        value?.v !== 1 ||
        value.binding !== binding ||
        !Number.isSafeInteger(value.at) ||
        value.at < 0 ||
        typeof value.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)
      )
        throw new Error();
      after = { at: value.at, id: value.id };
    } catch {
      throw new BadRequestException('Invalid Shorts page cursor');
    }
  }
  return { after, encode };
}

/** Wait for active reads to drain before propagating a failure or releasing admission. */
export async function catalogMap<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(items.length, 4) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await work(items[index]);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}

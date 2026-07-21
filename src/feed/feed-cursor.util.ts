import { BadRequestException } from '@nestjs/common';

export type FeedSort = 'latest' | 'hot';

export interface LatestFeedCursor {
  sort: 'latest';
  ts: number;
  // Primary keys (post.id / token.sale_address / transaction.tx_hash — their
  // string formats never collide) of every item already returned whose
  // created_at equals `ts` exactly. None of the three merged sources has a
  // secondary key that's both monotonic with time and shared across all
  // three, so ties at the cutoff are broken by exclusion instead: without
  // this, an item sharing the last item's timestamp could be silently
  // skipped at the page boundary. Bounded by the page limit, so this stays
  // small. Optional on encode (older/hand-built cursors just carry none);
  // decode always fills it in as `[]`.
  seenIds?: string[];
}

export interface HotFeedCursor {
  sort: 'hot';
  offset: number;
}

export type FeedCursor = LatestFeedCursor | HotFeedCursor;

// Opaque cursor: callers should treat this as a black box. Base64-encoded
// JSON is enough here — there is nothing sensitive in it and it never needs
// to be validated against tampering beyond "does it parse and match `sort`".
export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeFeedCursor(
  cursor: string | undefined,
  sort: FeedSort,
): FeedCursor | null {
  if (!cursor) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid cursor');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { sort?: unknown }).sort !== sort
  ) {
    throw new BadRequestException(`Invalid cursor for sort=${sort}`);
  }

  if (sort === 'latest') {
    const ts = (parsed as { ts?: unknown }).ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new BadRequestException('Invalid cursor');
    }
    const rawSeenIds = (parsed as { seenIds?: unknown }).seenIds;
    if (
      rawSeenIds !== undefined &&
      (!Array.isArray(rawSeenIds) ||
        !rawSeenIds.every((id) => typeof id === 'string'))
    ) {
      throw new BadRequestException('Invalid cursor');
    }
    return { sort: 'latest', ts, seenIds: (rawSeenIds as string[]) ?? [] };
  }

  const offset = (parsed as { offset?: unknown }).offset;
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) {
    throw new BadRequestException('Invalid cursor');
  }
  return { sort: 'hot', offset };
}

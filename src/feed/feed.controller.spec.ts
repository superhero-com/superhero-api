import { Brackets } from 'typeorm';
import { FeedController } from './feed.controller';
import { decodeFeedCursor, encodeFeedCursor } from './feed-cursor.util';

describe('FeedController', () => {
  let controller: FeedController;
  let postsRepository: { createQueryBuilder: jest.Mock };
  let tokensRepository: { createQueryBuilder: jest.Mock };
  let transactionsRepository: { createQueryBuilder: jest.Mock };
  let popularRankingService: { getPopularPostsPage: jest.Mock };

  const makeQueryBuilder = (rows: any[]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  beforeEach(() => {
    postsRepository = {
      createQueryBuilder: jest.fn(() => makeQueryBuilder([])),
    };
    tokensRepository = {
      createQueryBuilder: jest.fn(() => makeQueryBuilder([])),
    };
    transactionsRepository = {
      createQueryBuilder: jest.fn(() => makeQueryBuilder([])),
    };
    popularRankingService = {
      getPopularPostsPage: jest.fn().mockResolvedValue({
        items: [],
        totalItems: 0,
      }),
    };

    controller = new FeedController(
      postsRepository as any,
      tokensRepository as any,
      transactionsRepository as any,
      popularRankingService as any,
    );
  });

  it('rejects an invalid sort value', async () => {
    await expect(controller.getFeed('unknown', undefined, 20)).rejects.toThrow(
      'sort must be one of: latest, hot',
    );
  });

  describe('sort=latest', () => {
    it('merges posts, token creations, and trades by created_at desc', async () => {
      const post = {
        id: 'post_1',
        created_at: new Date('2026-01-03T00:00:00Z'),
      };
      const token = {
        sale_address: 'ct_1',
        created_at: new Date('2026-01-02T00:00:00Z'),
      };
      const trade = {
        tx_hash: 'th_1',
        created_at: new Date('2026-01-01T00:00:00Z'),
      };
      postsRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([post]),
      );
      tokensRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([token]),
      );
      transactionsRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([trade]),
      );

      const result = await controller.getFeed('latest', undefined, 20);

      expect(result.items).toEqual([
        { type: 'post', created_at: post.created_at, data: post },
        { type: 'token_created', created_at: token.created_at, data: token },
        { type: 'trade', created_at: trade.created_at, data: trade },
      ]);
      expect(result.next_cursor).toBeNull();
    });

    it('sets next_cursor when a source fills its own page', async () => {
      const posts = Array.from({ length: 2 }, (_, i) => ({
        id: `post_${i}`,
        created_at: new Date(Date.UTC(2026, 0, 3, 0, 0, i)),
      }));
      postsRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(posts),
      );

      const result = await controller.getFeed('latest', undefined, 2);

      expect(result.next_cursor).not.toBeNull();
      const decoded = decodeFeedCursor(result.next_cursor!, 'latest');
      const lastItem = result.items[result.items.length - 1];
      expect(decoded).toEqual({
        sort: 'latest',
        ts: lastItem.created_at.getTime(),
        seenIds: [(lastItem.data as { id: string }).id],
      });
    });

    it('applies the decoded cursor as a `created_at <` filter on every source', async () => {
      const postsQb = makeQueryBuilder([]);
      const tokensQb = makeQueryBuilder([]);
      const tradesQb = makeQueryBuilder([]);
      postsRepository.createQueryBuilder.mockReturnValue(postsQb);
      tokensRepository.createQueryBuilder.mockReturnValue(tokensQb);
      transactionsRepository.createQueryBuilder.mockReturnValue(tradesQb);

      const cursor = encodeFeedCursor({ sort: 'latest', ts: 1735689600000 });
      await controller.getFeed('latest', cursor, 20);

      const before = new Date(1735689600000);
      expect(postsQb.andWhere).toHaveBeenCalledWith(
        'post.created_at < :before',
        { before },
      );
      expect(tokensQb.andWhere).toHaveBeenCalledWith(
        'token.created_at < :before',
        { before },
      );
      expect(tradesQb.andWhere).toHaveBeenCalledWith(
        'transaction.created_at < :before',
        { before },
      );
    });

    it('excludes already-seen ids at an exact-timestamp tie instead of only filtering by <', async () => {
      const postsQb = makeQueryBuilder([]);
      const tokensQb = makeQueryBuilder([]);
      const tradesQb = makeQueryBuilder([]);
      postsRepository.createQueryBuilder.mockReturnValue(postsQb);
      tokensRepository.createQueryBuilder.mockReturnValue(tokensQb);
      transactionsRepository.createQueryBuilder.mockReturnValue(tradesQb);

      const before = new Date(1735689600000);
      const cursor = encodeFeedCursor({
        sort: 'latest',
        ts: before.getTime(),
        seenIds: ['post_seen', 'th_seen'],
      });
      await controller.getFeed('latest', cursor, 20);

      // Rather than only filtering by `<`, each source's query must OR in an
      // exact-tie branch that excludes the ids already returned for that
      // timestamp -- otherwise an item tied with the previous page's cutoff
      // would be silently skipped.
      for (const [qb, createdAtColumn, pkColumn] of [
        [postsQb, 'post.created_at', 'post.id'],
        [tokensQb, 'token.created_at', 'token.sale_address'],
        [tradesQb, 'transaction.created_at', 'transaction.tx_hash'],
      ] as const) {
        expect(qb.andWhere).toHaveBeenCalledWith(expect.any(Brackets));
        const brackets = qb.andWhere.mock.calls[0][0] as Brackets;
        const outer = {
          where: jest.fn().mockReturnThis(),
          orWhere: jest.fn().mockReturnThis(),
        };
        brackets.whereFactory(outer as any);

        expect(outer.where).toHaveBeenCalledWith(
          `${createdAtColumn} < :before`,
          {
            before,
          },
        );
        expect(outer.orWhere).toHaveBeenCalledWith(expect.any(Brackets));
        const inner = outer.orWhere.mock.calls[0][0] as Brackets;
        const innerQb = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
        };
        inner.whereFactory(innerQb as any);

        expect(innerQb.where).toHaveBeenCalledWith(
          `${createdAtColumn} = :before`,
          { before },
        );
        expect(innerQb.andWhere).toHaveBeenCalledWith(
          `${pkColumn} NOT IN (:...excludeIds)`,
          { excludeIds: ['post_seen', 'th_seen'] },
        );
      }
    });

    it('accumulates seenIds across pages when a tie spans more pages than fit in one limit', async () => {
      // 10 posts sharing the exact same created_at -- more than `limit` (4),
      // so the tie spans 3 pages. Each call's mock simulates what the real
      // DB would return once the previous pages' ids are excluded (that
      // exclusion SQL itself is covered by the test above); this test only
      // exercises the controller's own seenIds bookkeeping across pages.
      const tiedTs = Date.UTC(2026, 0, 3, 0, 0, 0);
      const allPosts = Array.from({ length: 10 }, (_, i) => ({
        id: `post_${i}`,
        created_at: new Date(tiedTs),
      }));
      tokensRepository.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));
      transactionsRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder([]),
      );

      // Page 1: no cursor yet.
      postsRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(allPosts.slice(0, 4)),
      );
      const page1 = await controller.getFeed('latest', undefined, 4);
      expect(page1.items.map((i) => (i.data as any).id)).toEqual([
        'post_0',
        'post_1',
        'post_2',
        'post_3',
      ]);
      const cursor1 = decodeFeedCursor(page1.next_cursor!, 'latest');
      expect(cursor1).toMatchObject({
        ts: tiedTs,
        seenIds: ['post_0', 'post_1', 'post_2', 'post_3'],
      });

      // Page 2: DB (simulated) excludes posts 0-3, returns the next 4.
      postsRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(allPosts.slice(4, 8)),
      );
      const page2 = await controller.getFeed('latest', page1.next_cursor!, 4);
      expect(page2.items.map((i) => (i.data as any).id)).toEqual([
        'post_4',
        'post_5',
        'post_6',
        'post_7',
      ]);
      const cursor2 = decodeFeedCursor(page2.next_cursor!, 'latest');
      // Must carry forward posts 0-3 from cursor1 in addition to 4-7, or a
      // page-3 query excluding only {4-7} would re-serve posts 0-3.
      expect(cursor2).toMatchObject({
        ts: tiedTs,
        seenIds: expect.arrayContaining([
          'post_0',
          'post_1',
          'post_2',
          'post_3',
          'post_4',
          'post_5',
          'post_6',
          'post_7',
        ]),
      });
      expect((cursor2 as any).seenIds).toHaveLength(8);

      // Page 3: DB (simulated) excludes posts 0-7, returns the final 2.
      postsRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(allPosts.slice(8, 10)),
      );
      const page3 = await controller.getFeed('latest', page2.next_cursor!, 4);
      expect(page3.items.map((i) => (i.data as any).id)).toEqual([
        'post_8',
        'post_9',
      ]);
      expect(page3.next_cursor).toBeNull();
    });

    it('rejects a hot cursor passed while sorting latest', async () => {
      const cursor = encodeFeedCursor({ sort: 'hot', offset: 10 });

      await expect(controller.getFeed('latest', cursor, 20)).rejects.toThrow(
        'Invalid cursor for sort=latest',
      );
    });
  });

  describe('sort=hot', () => {
    it('delegates to PopularRankingService and paginates by offset', async () => {
      const post = {
        id: 'post_1',
        created_at: new Date('2026-01-01T00:00:00Z'),
      };
      popularRankingService.getPopularPostsPage.mockResolvedValue({
        items: [post],
        totalItems: 5,
      });

      const result = await controller.getFeed('hot', undefined, 1);

      expect(popularRankingService.getPopularPostsPage).toHaveBeenCalledWith(
        'all',
        1,
        0,
      );
      expect(result.items).toEqual([
        { type: 'post', created_at: post.created_at, data: post },
      ]);
      expect(result.next_cursor).not.toBeNull();
      expect(decodeFeedCursor(result.next_cursor!, 'hot')).toEqual({
        sort: 'hot',
        offset: 1,
      });
    });

    it('returns null next_cursor once every item has been paged through', async () => {
      popularRankingService.getPopularPostsPage.mockResolvedValue({
        items: [{ id: 'post_1', created_at: new Date() }],
        totalItems: 1,
      });

      const result = await controller.getFeed('hot', undefined, 20);

      expect(result.next_cursor).toBeNull();
    });

    it('resumes from the offset encoded in the cursor', async () => {
      const cursor = encodeFeedCursor({ sort: 'hot', offset: 40 });

      await controller.getFeed('hot', cursor, 20);

      expect(popularRankingService.getPopularPostsPage).toHaveBeenCalledWith(
        'all',
        20,
        40,
      );
    });
  });
});

// The dumb `makeQueryBuilder` stub above always returns a fixed array
// regardless of the query, which can't catch a bug in the *pagination
// invariant itself* (does a full multi-page walk ever skip or duplicate an
// item?). This fake actually filters/sorts/limits an in-memory dataset --
// including evaluating the Brackets-based tie-break predicate -- so a full
// sweep across many pages exercises the real cursor/merge/slice logic
// end-to-end.
function makeRealisticQueryBuilder<T extends Record<string, any>>(
  rows: T[],
  createdAtField: string,
  pkField: string,
) {
  const conditions: Array<(row: T) => boolean> = [];
  let limitN = Infinity;

  function buildStringPredicate(sql: string, params: any): (row: T) => boolean {
    if (sql.includes(`${createdAtField} < :before`)) {
      const before = params.before as Date;
      return (row) => row[createdAtField].getTime() < before.getTime();
    }
    if (sql.includes(`${createdAtField} = :before`)) {
      const before = params.before as Date;
      return (row) => row[createdAtField].getTime() === before.getTime();
    }
    if (sql.includes(`${pkField} NOT IN (:...excludeIds)`)) {
      const excludeIds = params.excludeIds as string[];
      return (row) => !excludeIds.includes(row[pkField]);
    }
    // is_hidden/unlisted/tx_type filters -- not exercised by this harness.
    return () => true;
  }

  function buildBracketPredicate(brackets: Brackets): (row: T) => boolean {
    let combined: ((row: T) => boolean) | null = null;
    const subQb = {
      where(sqlOrBrackets: any, params?: any) {
        combined = toPredicate(sqlOrBrackets, params);
        return subQb;
      },
      andWhere(sqlOrBrackets: any, params?: any) {
        const next = toPredicate(sqlOrBrackets, params);
        const prev = combined!;
        combined = (row) => prev(row) && next(row);
        return subQb;
      },
      orWhere(sqlOrBrackets: any, params?: any) {
        const next = toPredicate(sqlOrBrackets, params);
        const prev = combined!;
        combined = (row) => prev(row) || next(row);
        return subQb;
      },
    };
    brackets.whereFactory(subQb as any);
    return combined!;
  }

  function toPredicate(sqlOrBrackets: any, params?: any): (row: T) => boolean {
    if (sqlOrBrackets instanceof Brackets) {
      return buildBracketPredicate(sqlOrBrackets);
    }
    return buildStringPredicate(sqlOrBrackets, params);
  }

  const qb: any = {
    where(sqlOrBrackets: any, params?: any) {
      conditions.push(toPredicate(sqlOrBrackets, params));
      return qb;
    },
    andWhere(sqlOrBrackets: any, params?: any) {
      conditions.push(toPredicate(sqlOrBrackets, params));
      return qb;
    },
    innerJoin() {
      return qb;
    },
    orderBy() {
      return qb;
    },
    limit(n: number) {
      limitN = n;
      return qb;
    },
    getMany: async () => {
      const filtered = rows.filter((row) =>
        conditions.every((cond) => cond(row)),
      );
      filtered.sort(
        (a, b) => b[createdAtField].getTime() - a[createdAtField].getTime(),
      );
      return filtered.slice(0, limitN);
    },
  };
  return qb;
}

describe('FeedController sort=latest full pagination sweep (no skips/duplicates)', () => {
  // A source that returns exactly `limit` rows this page but has no more
  // data ("phantom" hasMore) costs at most one extra, empty-tailed page --
  // it does not affect correctness, only causes one avoidable round trip.
  it('serves every eligible item exactly once, even when one source dominates every page', async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    // Posts: dense, one per second. Trades: sparse and offset from posts
    // (no ties), clustered in the same recent window -- designed so posts
    // alone can crowd trades out of the top `limit` for many consecutive
    // pages, the scenario a "dropped from the merge" bug would show up in.
    const posts = Array.from({ length: 60 }, (_, i) => ({
      id: `post_${i}`,
      created_at: new Date(now - i * 1000),
    }));
    const trades = Array.from({ length: 8 }, (_, i) => ({
      tx_hash: `th_${i}`,
      created_at: new Date(now - (i * 1000 + 500)),
    }));

    const controller = new FeedController(
      {
        createQueryBuilder: () =>
          makeRealisticQueryBuilder(posts, 'created_at', 'id'),
      } as any,
      {
        createQueryBuilder: () =>
          makeRealisticQueryBuilder([], 'created_at', 'sale_address'),
      } as any,
      {
        createQueryBuilder: () =>
          makeRealisticQueryBuilder(trades, 'created_at', 'tx_hash'),
      } as any,
      { getPopularPostsPage: jest.fn() } as any,
    );

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    const MAX_PAGES = 50;

    do {
      const result: any = await controller.getFeed('latest', cursor, 5);
      for (const item of result.items) {
        const id = item.type === 'trade' ? item.data.tx_hash : item.data.id;
        expect(seen.has(id)).toBe(false); // never re-served
        seen.add(id);
      }
      cursor = result.next_cursor ?? undefined;
      pages++;
    } while (cursor && pages < MAX_PAGES);

    expect(pages).toBeLessThan(MAX_PAGES); // pagination actually terminated

    const expectedIds = new Set([
      ...posts.map((p) => p.id),
      ...trades.map((t) => t.tx_hash),
    ]);
    expect(seen).toEqual(expectedIds); // nothing skipped, nothing missing
  });
});

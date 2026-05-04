const pipelineMock = {
  zadd: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec: jest
    .fn()
    .mockResolvedValue(Array.from({ length: 64 }, () => [null, 1] as const)),
};

const redisMock = {
  ping: jest.fn().mockResolvedValue('PONG'),
  del: jest.fn().mockResolvedValue(1),
  zcard: jest.fn().mockResolvedValue(1),
  pipeline: jest.fn().mockReturnValue(pipelineMock),
};

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => redisMock),
  };
});

import { PopularRankingService } from './popular-ranking.service';

describe('PopularRankingService', () => {
  let service: PopularRankingService;
  let postRepository: any;
  let tipRepository: any;
  let trendingTagRepository: any;
  let postReadsRepository: any;

  beforeEach(() => {
    const candidateQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          id: 'post-1',
          sender_address: 'ak_author',
          created_at: new Date().toISOString(),
          total_comments: 0,
          content: '',
          topics: [],
        },
      ]),
    };
    const tipQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const commentQueryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const readsQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    postRepository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(candidateQueryBuilder)
        .mockReturnValueOnce(commentQueryBuilder),
      findBy: jest.fn().mockResolvedValue([]),
    };
    tipRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(tipQueryBuilder),
    };
    trendingTagRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    postReadsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(readsQueryBuilder),
    };

    service = new PopularRankingService(
      postRepository as any,
      tipRepository as any,
      trendingTagRepository as any,
      postReadsRepository as any,
      [],
    );
  });

  it('excludes self-tips from popular ranking tip aggregates', async () => {
    await service.recompute('7d', 10);

    const tipQueryBuilder =
      tipRepository.createQueryBuilder.mock.results[0].value;

    expect(tipQueryBuilder.innerJoin).toHaveBeenCalledWith(
      expect.any(Function),
      'post',
      'post.id = tip.post_id',
    );
    expect(tipQueryBuilder.andWhere).toHaveBeenCalledWith(
      'tip.sender_address != post.sender_address',
    );
  });

  it('excludes self-comments from ranking comment count', async () => {
    await service.recompute('7d', 10);

    const commentQueryBuilder =
      postRepository.createQueryBuilder.mock.results[1].value;

    expect(commentQueryBuilder.innerJoin).toHaveBeenCalledWith(
      expect.any(Function),
      'parent',
      'parent.id = comment.post_id',
    );
    expect(commentQueryBuilder.andWhere).toHaveBeenCalledWith(
      'comment.sender_address != parent.sender_address',
    );
  });

  it('falls back to window-filtered recent posts when Redis cache is empty', async () => {
    jest.spyOn(service, 'recompute').mockResolvedValue(undefined);
    redisMock.zcard
      .mockResolvedValueOnce(0) // getVerifiedPopularIds — cache empty
      .mockResolvedValueOnce(0); // after awaited recompute — still empty

    const fallbackPost = {
      id: 'fallback-1',
      created_at: new Date().toISOString(),
      content: 'hello',
    };
    const fallbackQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([fallbackPost]),
    };
    postRepository.createQueryBuilder = jest
      .fn()
      .mockReturnValueOnce(fallbackQueryBuilder);

    const result = await service.getPopularPosts('24h', 10, 0);

    expect(result).toEqual([fallbackPost]);
    expect(fallbackQueryBuilder.orderBy).toHaveBeenCalledWith(
      'post.created_at',
      'DESC',
    );
    expect(fallbackQueryBuilder.andWhere).toHaveBeenCalledWith(
      'post.created_at >= :since',
      expect.objectContaining({ since: expect.any(Date) }),
    );
  });

  it('reorders personalized popular results by interactions per hour', async () => {
    const now = Date.now();
    const fastPost = {
      id: 'post-fast',
      sender_address: 'ak_fast',
      created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      total_comments: 0,
      content: 'fast',
      topics: [],
    };
    const oldPost = {
      id: 'post-old',
      sender_address: 'ak_old',
      created_at: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
      total_comments: 0,
      content: 'old',
      topics: [],
    };
    const candidateQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([oldPost, fastPost]),
    };
    const tipQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          post_id: 'post-old',
          amount_sum: '0',
          count: '2',
          unique_tippers: '2',
        },
        {
          post_id: 'post-fast',
          amount_sum: '0',
          count: '2',
          unique_tippers: '2',
        },
      ]),
    };
    const commentQueryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { parent_id: 'post-old', count: '4' },
        { parent_id: 'post-fast', count: '4' },
      ]),
    };
    const readsQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { post_id: 'post-old', reads: '10' },
        { post_id: 'post-fast', reads: '10' },
      ]),
    };

    postRepository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(candidateQueryBuilder)
        .mockReturnValueOnce(commentQueryBuilder),
      findBy: jest.fn().mockResolvedValue([oldPost, fastPost]),
    };
    tipRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(tipQueryBuilder),
    };
    postReadsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(readsQueryBuilder),
    };
    service = new PopularRankingService(
      postRepository as any,
      tipRepository as any,
      trendingTagRepository as any,
      postReadsRepository as any,
      [],
    );

    const result = await service.getPopularPostsPage('24h', 10, 0, undefined, {
      interactionsPerHour: 'high',
    });

    expect(result.items.map((item) => item.id)).toEqual([
      'post-fast',
      'post-old',
    ]);
    expect(result.totalItems).toBe(2);
  });

  describe('getPopularPostsPage without overrides (Redis path)', () => {
    it('delegates to the cached Redis path and returns totalItems', async () => {
      const postA = {
        id: 'post-a',
        sender_address: 'ak_a',
        content: 'a',
        is_hidden: false,
        post_id: null,
      };
      const postB = {
        id: 'post-b',
        sender_address: 'ak_b',
        content: 'b',
        is_hidden: false,
        post_id: null,
      };

      redisMock.zcard.mockResolvedValue(2);
      (redisMock as any).zrevrange = jest
        .fn()
        .mockResolvedValue(['post-a', '10', 'post-b', '5']);
      postRepository.findBy = jest.fn().mockResolvedValue([postA, postB]);

      const result = await service.getPopularPostsPage(
        '24h',
        10,
        0,
        undefined,
        {},
      );

      expect(result.items.length).toBe(2);
      expect(result.scoredItems).toBeUndefined();

      redisMock.zcard.mockResolvedValue(1);
    });

    it('does not duplicate items across consecutive cached diversified pages', async () => {
      const posts = [
        {
          id: 'post-a-strong',
          sender_address: 'ak_author_a',
          content: 'strong post',
          is_hidden: false,
          post_id: null,
        },
        {
          id: 'post-a-second',
          sender_address: 'ak_author_a',
          content: 'second post',
          is_hidden: false,
          post_id: null,
        },
        {
          id: 'post-b',
          sender_address: 'ak_author_b',
          content: 'other author post',
          is_hidden: false,
          post_id: null,
        },
        {
          id: 'post-c',
          sender_address: 'ak_author_c',
          content: 'third author post',
          is_hidden: false,
          post_id: null,
        },
      ];

      redisMock.zcard.mockResolvedValue(4);
      (redisMock as any).zrevrange = jest
        .fn()
        .mockResolvedValue([
          'post-a-strong',
          '10',
          'post-a-second',
          '8',
          'post-b',
          '1',
          'post-c',
          '0',
        ]);
      postRepository.findBy = jest.fn().mockResolvedValue(posts);

      const firstPage = await service.getPopularPostsPage('all', 2, 0);
      const secondPage = await service.getPopularPostsPage('all', 2, 2);

      const firstPageIds = firstPage.items.map((item) => item.id);
      const secondPageIds = secondPage.items.map((item) => item.id);

      expect(firstPageIds).toEqual(['post-a-strong', 'post-b']);
      expect(secondPageIds).toEqual(['post-a-second', 'post-c']);
      expect(firstPageIds.some((id) => secondPageIds.includes(id))).toBe(false);
    });
  });

  describe('resolveWeights', () => {
    function buildServiceForWeightTests() {
      const now = Date.now();
      const post = {
        id: 'post-w',
        sender_address: 'ak_w',
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        total_comments: 0,
        content: 'weight test content that is long enough',
        topics: [],
      };
      const candidateQB = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([post]),
      };
      const commentQB = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ parent_id: 'post-w', count: '5' }]),
      };
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            post_id: 'post-w',
            amount_sum: '100',
            count: '3',
            unique_tippers: '2',
          },
        ]),
      };
      const readsQB = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ post_id: 'post-w', reads: '20' }]),
      };

      const repo = {
        createQueryBuilder: jest
          .fn()
          .mockReturnValueOnce(candidateQB)
          .mockReturnValueOnce(commentQB),
        findBy: jest.fn().mockResolvedValue([post]),
      };
      const tipRepo = { createQueryBuilder: jest.fn().mockReturnValue(tipQB) };
      const readsRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(readsQB),
      };

      return new PopularRankingService(
        repo as any,
        tipRepo as any,
        trendingTagRepository as any,
        readsRepo as any,
        [],
      );
    }

    it('applies multiple simultaneous overrides (comments=high, reads=low)', async () => {
      const svc = buildServiceForWeightTests();
      const result = await svc.getPopularPostsPage('24h', 10, 0, undefined, {
        comments: 'high',
        reads: 'low',
      });

      expect(result.totalItems).toBe(1);
      expect(result.scoredItems).toBeDefined();
      expect(result.scoredItems![0].score).toBeGreaterThan(0);
    });

    it('returns default ranking when all override values are undefined', async () => {
      const svc = buildServiceForWeightTests();
      const postW = { id: 'post-w', sender_address: 'ak_w', content: 'w' };
      redisMock.zcard.mockResolvedValue(1);
      (redisMock as any).zrevrange = jest
        .fn()
        .mockResolvedValue(['post-w', '10']);
      (svc as any).postRepository.findBy = jest.fn().mockResolvedValue([postW]);

      const result = await svc.getPopularPostsPage('24h', 10, 0, undefined, {
        comments: undefined,
        reads: undefined,
      });

      expect(result.scoredItems).toBeUndefined();

      redisMock.zcard.mockResolvedValue(1);
    });
  });

  describe('computeInteractionsPerHour edge cases', () => {
    function buildServiceWith(post: any) {
      const candidateQB = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([post]),
      };
      const commentQB = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ parent_id: post.id, count: '3' }]),
      };
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            post_id: post.id,
            amount_sum: '0',
            count: '1',
            unique_tippers: '1',
          },
        ]),
      };
      const readsQB = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      return new PopularRankingService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(candidateQB)
            .mockReturnValueOnce(commentQB),
          findBy: jest.fn().mockResolvedValue([post]),
        } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(tipQB) } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(readsQB) } as any,
        [],
      );
    }

    it('handles future createdAt without negative scores', async () => {
      const futurePost = {
        id: 'post-future',
        sender_address: 'ak_f',
        created_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        content: 'from the future',
        topics: [],
      };
      const svc = buildServiceWith(futurePost);
      const result = await svc.getPopularPostsPage('24h', 10, 0, undefined, {
        interactionsPerHour: 'high',
      });

      expect(result.totalItems).toBe(1);
      expect(result.scoredItems![0].score).toBeGreaterThanOrEqual(0);
    });

    it('handles invalid date string gracefully (interactionsPerHour = 0)', async () => {
      const badDatePost = {
        id: 'post-bad-date',
        sender_address: 'ak_bad',
        created_at: 'not-a-date',
        content: 'bad date content',
        topics: [],
      };
      const svc = buildServiceWith(badDatePost);
      const result = await svc.getPopularPostsPage('24h', 10, 0, undefined, {
        interactionsPerHour: 'high',
      });

      expect(result.totalItems).toBe(1);
      expect(result.scoredItems![0].score).toBeGreaterThanOrEqual(0);
    });

    it('caps effectiveHours to window size for 24h window', async () => {
      const now = Date.now();
      const very_old_post = {
        id: 'post-capped',
        sender_address: 'ak_capped',
        created_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
        content: 'old post that should be capped at 24h',
        topics: [],
      };
      const recent_post = {
        id: 'post-recent',
        sender_address: 'ak_recent',
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        content: 'recent post within window',
        topics: [],
      };

      const candidateQB = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([very_old_post, recent_post]),
      };
      const commentQB = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { parent_id: 'post-capped', count: '5' },
          { parent_id: 'post-recent', count: '5' },
        ]),
      };
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            post_id: 'post-capped',
            amount_sum: '0',
            count: '2',
            unique_tippers: '2',
          },
          {
            post_id: 'post-recent',
            amount_sum: '0',
            count: '2',
            unique_tippers: '2',
          },
        ]),
      };
      const readsQB = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { post_id: 'post-capped', reads: '10' },
          { post_id: 'post-recent', reads: '10' },
        ]),
      };

      const svc = new PopularRankingService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(candidateQB)
            .mockReturnValueOnce(commentQB),
          findBy: jest.fn().mockResolvedValue([very_old_post, recent_post]),
        } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(tipQB) } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(readsQB) } as any,
        [],
      );

      const result = await svc.getPopularPostsPage('24h', 10, 0, undefined, {
        interactionsPerHour: 'high',
      });

      expect(result.scoredItems).toBeDefined();
      expect(
        result.scoredItems!.find((s) => s.postId === 'post-recent')!.score,
      ).toBeGreaterThan(
        result.scoredItems!.find((s) => s.postId === 'post-capped')!.score,
      );
    });
  });

  describe('pagination edge cases', () => {
    it('returns empty items when offset exceeds total candidates', async () => {
      const result = await service.getPopularPostsPage(
        '24h',
        10,
        9999,
        undefined,
        {
          comments: 'high',
        },
      );

      expect(result.items).toEqual([]);
      expect(result.totalItems).toBe(1);
    });
  });

  describe('live popular behavior', () => {
    function buildScoredService(
      posts: any[],
      comments: Record<string, string>,
    ) {
      const candidateQB = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(posts),
      };
      const commentQB = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(
          Object.entries(comments).map(([parent_id, count]) => ({
            parent_id,
            count,
          })),
        ),
      };
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const readsQB = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      return new PopularRankingService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(candidateQB)
            .mockReturnValueOnce(commentQB),
          findBy: jest.fn().mockResolvedValue(posts),
        } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(tipQB) } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(readsQB) } as any,
        [],
      );
    }

    it('boosts fresh posts and removes that boost after 24 hours', async () => {
      const now = Date.now();
      const freshPost = {
        id: 'post-fresh',
        sender_address: 'ak_fresh',
        created_at: new Date(now - 60 * 60 * 1000).toISOString(),
        content: 'same quality content',
        topics: [],
      };
      const dayOldPost = {
        id: 'post-day-old',
        sender_address: 'ak_day_old',
        created_at: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
        content: 'same quality content',
        topics: [],
      };
      const olderPost = {
        id: 'post-older',
        sender_address: 'ak_older',
        created_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
        content: 'same quality content',
        topics: [],
      };
      const svc = buildScoredService([dayOldPost, olderPost, freshPost], {});

      const result = await svc.getPopularPostsPage('all', 10, 0, undefined, {
        comments: 'med',
      });
      const scores = new Map(
        result.scoredItems!.map((item) => [item.postId, item.score]),
      );

      expect(scores.get('post-fresh')).toBeGreaterThan(
        scores.get('post-day-old')!,
      );
      expect(scores.get('post-day-old')).toBeCloseTo(scores.get('post-older')!);
    });

    it('avoids duplicate authors within a page when alternatives exist', async () => {
      const now = Date.now();
      const posts = [
        {
          id: 'post-a-strong',
          sender_address: 'ak_author_a',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'strong post',
          topics: [],
        },
        {
          id: 'post-a-second',
          sender_address: 'ak_author_a',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'second post',
          topics: [],
        },
        {
          id: 'post-b',
          sender_address: 'ak_author_b',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'other author post',
          topics: [],
        },
      ];
      const svc = buildScoredService(posts, {
        'post-a-strong': '10',
        'post-a-second': '8',
        'post-b': '1',
      });

      const result = await svc.getPopularPostsPage('all', 2, 0, undefined, {
        comments: 'high',
      });

      expect(result.items.map((item) => item.id)).toEqual([
        'post-a-strong',
        'post-b',
      ]);
    });

    it('does not duplicate items across consecutive diversified pages', async () => {
      const now = Date.now();
      const posts = [
        {
          id: 'post-a-strong',
          sender_address: 'ak_author_a',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'strong post',
          topics: [],
        },
        {
          id: 'post-a-second',
          sender_address: 'ak_author_a',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'second post',
          topics: [],
        },
        {
          id: 'post-b',
          sender_address: 'ak_author_b',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'other author post',
          topics: [],
        },
        {
          id: 'post-c',
          sender_address: 'ak_author_c',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'third author post',
          topics: [],
        },
      ];

      const firstPageService = buildScoredService(posts, {
        'post-a-strong': '10',
        'post-a-second': '8',
        'post-b': '1',
        'post-c': '0',
      });
      const secondPageService = buildScoredService(posts, {
        'post-a-strong': '10',
        'post-a-second': '8',
        'post-b': '1',
        'post-c': '0',
      });

      const firstPage = await firstPageService.getPopularPostsPage(
        'all',
        2,
        0,
        undefined,
        { comments: 'high' },
      );
      const secondPage = await secondPageService.getPopularPostsPage(
        'all',
        2,
        2,
        undefined,
        { comments: 'high' },
      );

      const firstPageIds = firstPage.items.map((item) => item.id);
      const secondPageIds = secondPage.items.map((item) => item.id);

      expect(firstPageIds).toEqual(['post-a-strong', 'post-b']);
      expect(secondPageIds).toEqual(['post-a-second', 'post-c']);
      expect(firstPageIds.some((id) => secondPageIds.includes(id))).toBe(false);
    });

    it('explains the same diversified items returned by personalized ranking', async () => {
      const now = Date.now();
      const posts = [
        {
          id: 'post-a-strong',
          sender_address: 'ak_author_a',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'strong post',
          topics: [],
        },
        {
          id: 'post-a-second',
          sender_address: 'ak_author_a',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'second post',
          topics: [],
        },
        {
          id: 'post-b',
          sender_address: 'ak_author_b',
          created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          content: 'other author post',
          topics: [],
        },
      ];
      const svc = buildScoredService(posts, {
        'post-a-strong': '10',
        'post-a-second': '8',
        'post-b': '1',
      });
      const weightOverrides = { comments: 'high' as const };

      const result = await svc.getPopularPostsPage(
        'all',
        2,
        0,
        undefined,
        weightOverrides,
      );
      const explanation = await svc.explain(
        'all',
        2,
        0,
        weightOverrides,
        result.scoredItems,
      );

      expect(explanation.map((item) => item.id)).toEqual(
        result.items.map((item) => item.id),
      );
    });
  });

  describe('explain', () => {
    it('returns unified shape with personalized flag for default path', async () => {
      const post = {
        id: 'post-explain',
        tx_hash: 'tx_123',
        sender_address: 'ak_explain',
      };
      (redisMock as any).zrevrange = jest
        .fn()
        .mockResolvedValue(['post-explain']);
      postRepository.findBy = jest.fn().mockResolvedValue([post]);

      const result = await service.explain('24h', 10, 0);

      expect(result).toEqual([
        expect.objectContaining({
          id: 'post-explain',
          tx: 'tx_123',
          author: 'ak_explain',
          personalized: false,
          appliedWeights: expect.objectContaining({
            comments: expect.any(Number),
          }),
        }),
      ]);
    });

    it('returns unified shape with personalized flag for override path', async () => {
      const post = {
        id: 'post-p',
        sender_address: 'ak_p',
        tx_hash: 'tx_p',
        created_at: new Date().toISOString(),
        content: 'personalized',
        topics: [],
      };
      const candidateQB = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([post]),
      };
      const commentQB = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const readsQB = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      const svc = new PopularRankingService(
        {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(candidateQB)
            .mockReturnValueOnce(commentQB),
          findBy: jest.fn().mockResolvedValue([post]),
        } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(tipQB) } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(readsQB) } as any,
        [],
      );

      const result = await svc.explain('24h', 10, 0, { comments: 'high' });

      expect(result).toEqual([
        expect.objectContaining({
          id: 'post-p',
          personalized: true,
          appliedWeights: expect.objectContaining({
            comments: expect.any(Number),
            interactionsPerHour: expect.any(Number),
          }),
        }),
      ]);
    });

    it('accepts precomputed scored items to avoid redundant computation', async () => {
      const precomputed = [{ postId: 'post-1', score: 42, type: 'post' }];
      postRepository.findBy = jest
        .fn()
        .mockResolvedValue([
          { id: 'post-1', tx_hash: 'tx_1', sender_address: 'ak_1' },
        ]);

      const result = await service.explain(
        '24h',
        10,
        0,
        { comments: 'high' },
        precomputed,
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('post-1');
      expect(postRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});

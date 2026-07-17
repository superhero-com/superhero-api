const pipelineMock = {
  zadd: jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec: jest
    .fn()
    .mockResolvedValue(Array.from({ length: 64 }, () => [null, 1] as const)),
};

const redisMock = {
  on: jest.fn().mockReturnThis(),
  quit: jest.fn().mockResolvedValue('OK'),
  ping: jest.fn().mockResolvedValue('PONG'),
  del: jest.fn().mockResolvedValue(1),
  set: jest.fn().mockResolvedValue('OK'),
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
import { POPULAR_RANKING_CONFIG } from '@/configs/constants';

function createCandidateQueryBuilder(posts: Array<{ id: string }>) {
  return {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest
      .fn()
      .mockResolvedValue(posts.map((post) => ({ id: post.id }))),
  };
}

describe('PopularRankingService', () => {
  let service: PopularRankingService;
  let postRepository: any;
  let tipRepository: any;
  let trendingTagRepository: any;
  let postReadsRepository: any;

  beforeEach(() => {
    const defaultPost = {
      id: 'post-1',
      sender_address: 'ak_author',
      created_at: new Date().toISOString(),
      total_comments: 0,
      content: '',
      topics: [],
    };
    const candidateQueryBuilder = createCandidateQueryBuilder([defaultPost]);
    const tipQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
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
      createQueryBuilder: jest.fn().mockReturnValue(candidateQueryBuilder),
      query: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue([defaultPost]),
      findBy: jest.fn().mockResolvedValue([defaultPost]),
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

  it('counts whole threads while excluding the root author from comment count', async () => {
    await service.recompute('7d', 10);

    const [sql, params] = postRepository.query.mock.calls[0];

    expect(sql).toContain('WITH RECURSIVE');
    expect(sql).toContain('c.sender_address != t.root_sender');
    expect(sql).toContain('c.is_hidden = false');
    expect(sql).toContain('t.depth <');
    expect(params[0]).toEqual(['post-1']);
    expect(params[1]).toBeInstanceOf(Date);
  });

  it('falls back to window-filtered recent posts when Redis cache is empty', async () => {
    jest.spyOn(service, 'recompute').mockResolvedValue(undefined);
    redisMock.zcard
      .mockResolvedValueOnce(0) // getVerifiedPopularIds РІР‚вЂќ cache empty
      .mockResolvedValueOnce(0); // after awaited recompute РІР‚вЂќ still empty

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
    const candidateQueryBuilder = createCandidateQueryBuilder([
      oldPost,
      fastPost,
    ]);
    const tipQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          post_id: 'post-old',
          amount_sum: '0',
          count: '2',
          unique_tippers: '2',
          recent_count: '2',
        },
        {
          post_id: 'post-fast',
          amount_sum: '0',
          count: '2',
          unique_tippers: '2',
          recent_count: '2',
        },
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
      createQueryBuilder: jest.fn().mockReturnValue(candidateQueryBuilder),
      query: jest.fn().mockResolvedValue([
        { root_id: 'post-old', count: '4', recent_count: '4' },
        { root_id: 'post-fast', count: '4', recent_count: '4' },
      ]),
      find: jest.fn().mockResolvedValue([oldPost, fastPost]),
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
      const candidateQB = createCandidateQueryBuilder([post]);
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            post_id: 'post-w',
            amount_sum: '100',
            count: '3',
            unique_tippers: '2',
            recent_count: '3',
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
        createQueryBuilder: jest.fn().mockReturnValue(candidateQB),
        query: jest
          .fn()
          .mockResolvedValue([
            { root_id: 'post-w', count: '5', recent_count: '5' },
          ]),
        find: jest.fn().mockResolvedValue([post]),
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
      const candidateQB = createCandidateQueryBuilder([post]);
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            post_id: post.id,
            amount_sum: '0',
            count: '1',
            unique_tippers: '1',
            recent_count: '1',
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
          createQueryBuilder: jest.fn().mockReturnValue(candidateQB),
          query: jest
            .fn()
            .mockResolvedValue([
              { root_id: post.id, count: '3', recent_count: '3' },
            ]),
          find: jest.fn().mockResolvedValue([post]),
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

    it('caps velocity hours so equal recent activity favors the younger post', async () => {
      const now = Date.now();
      const very_old_post = {
        id: 'post-capped',
        sender_address: 'ak_capped',
        created_at: new Date(now - 200 * 60 * 60 * 1000).toISOString(),
        content: 'old post whose velocity divisor is capped',
        topics: [],
      };
      const recent_post = {
        id: 'post-recent',
        sender_address: 'ak_recent',
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        content: 'recent post within window',
        topics: [],
      };

      const candidateQB = createCandidateQueryBuilder([
        very_old_post,
        recent_post,
      ]);
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          {
            post_id: 'post-capped',
            amount_sum: '0',
            count: '2',
            unique_tippers: '2',
            recent_count: '2',
          },
          {
            post_id: 'post-recent',
            amount_sum: '0',
            count: '2',
            unique_tippers: '2',
            recent_count: '2',
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
          createQueryBuilder: jest.fn().mockReturnValue(candidateQB),
          query: jest.fn().mockResolvedValue([
            { root_id: 'post-capped', count: '5', recent_count: '5' },
            { root_id: 'post-recent', count: '5', recent_count: '5' },
          ]),
          find: jest.fn().mockResolvedValue([very_old_post, recent_post]),
          findBy: jest.fn().mockResolvedValue([very_old_post, recent_post]),
        } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(tipQB) } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(readsQB) } as any,
        [],
      );

      const result = await svc.getPopularPostsPage('all', 10, 0, undefined, {
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
      const candidateQB = createCandidateQueryBuilder(posts);
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
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
          createQueryBuilder: jest.fn().mockReturnValue(candidateQB),
          query: jest.fn().mockResolvedValue(
            Object.entries(comments).map(([root_id, count]) => ({
              root_id,
              count,
              recent_count: count,
            })),
          ),
          find: jest.fn().mockResolvedValue(posts),
          findBy: jest.fn().mockResolvedValue(posts),
        } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(tipQB) } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(readsQB) } as any,
        [],
      );
    }

    it('limits distinct candidate posts before hydrating topics', async () => {
      const now = Date.now();
      const topicHeavyPost = {
        id: 'topic-heavy',
        sender_address: 'ak_topic_heavy',
        created_at: new Date(now - 60 * 60 * 1000).toISOString(),
        content: 'topic heavy post',
        topics: [{ name: 'ae' }, { name: 'superhero' }],
      };
      const targetPost = {
        id: 'target-post',
        sender_address: 'ak_target',
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        content: 'older target post with strong engagement',
        topics: [],
      };
      const candidateQB = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ id: 'topic-heavy' }, { id: 'target-post' }]),
      };
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
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
      const repo = {
        createQueryBuilder: jest.fn().mockReturnValue(candidateQB),
        query: jest
          .fn()
          .mockResolvedValue([
            { root_id: 'target-post', count: '4', recent_count: '4' },
          ]),
        find: jest.fn().mockResolvedValue([targetPost, topicHeavyPost]),
        findBy: jest.fn().mockResolvedValue([targetPost, topicHeavyPost]),
      };
      const svc = new PopularRankingService(
        repo as any,
        { createQueryBuilder: jest.fn().mockReturnValue(tipQB) } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
        { createQueryBuilder: jest.fn().mockReturnValue(readsQB) } as any,
        [],
      );

      const result = await svc.getPopularPostsPage('all', 10, 0, undefined, {
        comments: 'med',
      });

      expect(candidateQB.leftJoinAndSelect).not.toHaveBeenCalled();
      expect(candidateQB.select).toHaveBeenCalledWith('post.id', 'id');
      expect(repo.find).toHaveBeenCalledWith({
        where: { id: expect.anything() },
        relations: ['topics'],
      });
      expect(result.scoredItems!.map((item) => item.postId)).toEqual([
        'target-post',
        'topic-heavy',
      ]);
    });

    it('boosts fresh posts and removes that boost after the freshness window', async () => {
      const now = Date.now();
      const boostHours = POPULAR_RANKING_CONFIG.FRESHNESS_BOOST_HOURS;
      const freshPost = {
        id: 'post-fresh',
        sender_address: 'ak_fresh',
        created_at: new Date(now - 60 * 60 * 1000).toISOString(),
        content: 'same quality content',
        topics: [],
      };
      const pastWindowPost = {
        id: 'post-past-window',
        sender_address: 'ak_past_window',
        created_at: new Date(
          now - (boostHours + 2) * 60 * 60 * 1000,
        ).toISOString(),
        content: 'same quality content',
        topics: [],
      };
      const olderPost = {
        id: 'post-older',
        sender_address: 'ak_older',
        created_at: new Date(
          now - (boostHours + 26) * 60 * 60 * 1000,
        ).toISOString(),
        content: 'same quality content',
        topics: [],
      };
      const svc = buildScoredService(
        [pastWindowPost, olderPost, freshPost],
        {},
      );

      // 7d window: the 'all' window now applies age gravity, so equal-score
      // posts of different ages are only expected on time-bounded windows.
      const result = await svc.getPopularPostsPage('7d', 10, 0, undefined, {
        comments: 'med',
      });
      const scores = new Map(
        result.scoredItems!.map((item) => [item.postId, item.score]),
      );

      expect(scores.get('post-fresh')).toBeGreaterThan(
        scores.get('post-past-window')!,
      );
      // Past the window both posts carry no freshness or velocity — scores
      // may differ only by the deterministic tie-rotation jitter.
      expect(
        Math.abs(scores.get('post-past-window')! - scores.get('post-older')!),
      ).toBeLessThanOrEqual(POPULAR_RANKING_CONFIG.TIE_ROTATION_EPSILON);
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

  describe('scoring math (velocity, gravity, emoji)', () => {
    const noTrending = new Map<string, number>();

    function scoreInput(ageHours: number, overrides: Record<string, any> = {}) {
      return {
        content: 'a perfectly reasonable amount of content',
        comments: 0,
        tipsAmountAE: 0,
        tipsCount: 0,
        uniqueTippers: 0,
        reads: 0,
        topics: [],
        createdAt: new Date(
          Date.now() - ageHours * 60 * 60 * 1000,
        ).toISOString(),
        ...overrides,
      };
    }

    it('seeds interactionsPerHour weight from config for the default feed', () => {
      const weights = (service as any).resolveWeights();
      expect(weights.interactionsPerHour).toBe(
        POPULAR_RANKING_CONFIG.WEIGHTS.interactionsPerHour,
      );
      expect(weights.interactionsPerHour).toBeGreaterThan(0);
    });

    it('scales the interactionsPerHour override from the config default', () => {
      const weights = (service as any).resolveWeights({
        interactionsPerHour: 'high',
      });
      expect(weights.interactionsPerHour).toBeCloseTo(
        POPULAR_RANKING_CONFIG.WEIGHTS.interactionsPerHour *
          POPULAR_RANKING_CONFIG.CUSTOMIZATION.SCALE_MULTIPLIERS.high,
      );
    });

    it('keeps a positive velocity contribution past the freshness window on default weights', () => {
      // Both posts are the same age and past FRESHNESS_BOOST_HOURS, so the
      // freshness-gated terms are zero for both and there is no gravity/penalty
      // to confound them (7d window). The only gap comes from the always-on
      // interactionsPerHour term, driven here by recent activity.
      const age = POPULAR_RANKING_CONFIG.FRESHNESS_BOOST_HOURS + 60;
      const weights = (service as any).resolveWeights();
      const momentum = (service as any).computeScore(
        noTrending,
        scoreInput(age, { comments: 48, recentInteractions: 96 }),
        weights,
        '7d',
      );
      const slowBurn = (service as any).computeScore(
        noTrending,
        scoreInput(age, { comments: 48, recentInteractions: 0 }),
        weights,
        '7d',
      );
      expect(momentum).toBeGreaterThan(slowBurn);
    });

    it("decays older posts in the 'all' window given identical engagement", () => {
      const weights = (service as any).resolveWeights();
      const newer = (service as any).computeScore(
        noTrending,
        scoreInput(24, { comments: 20, reads: 100 }),
        weights,
        'all',
      );
      const older = (service as any).computeScore(
        noTrending,
        scoreInput(24 * 30, { comments: 20, reads: 100 }),
        weights,
        'all',
      );
      expect(newer).toBeGreaterThan(older);
    });

    it("does not decay time-bounded windows' scores by age gravity", () => {
      // Same totals, same age: gravity applies only to 'all', so the '24h'
      // score must be strictly higher than the gravity-divided 'all' score.
      const weights = (service as any).resolveWeights();
      const input = scoreInput(10, { comments: 20 });
      const windowed = (service as any).computeScore(
        noTrending,
        input,
        weights,
        '24h',
      );
      const allWindow = (service as any).computeScore(
        noTrending,
        input,
        weights,
        'all',
      );
      expect(windowed).toBeGreaterThan(allWindow);
    });

    it('registers momentum for an old post catching fire via recent interactions', () => {
      // Same lifetime totals, same age (so identical gravity); only the
      // recent-interaction count differs.
      const weights = (service as any).resolveWeights();
      const catchingFire = (service as any).computeScore(
        noTrending,
        scoreInput(24 * 90, { comments: 100, recentInteractions: 50 }),
        weights,
        'all',
      );
      const dormant = (service as any).computeScore(
        noTrending,
        scoreInput(24 * 90, { comments: 100, recentInteractions: 0 }),
        weights,
        'all',
      );
      expect(catchingFire).toBeGreaterThan(dormant);
    });

    it('caps read contribution relative to active engagement', () => {
      const weights = (service as any).resolveWeights();
      const cap = POPULAR_RANKING_CONFIG.READS_PER_INTERACTION_CAP;

      // `computeScore` -> `computeFreshnessFactor`/`computeInteractionsPerHour`
      // call `Date.now()` live on every invocation, so two calls a few
      // microseconds apart get a genuinely different age-in-hours and thus a
      // genuinely different (if tiny) score — flaking a `toBeCloseTo(..., 10)`
      // assertion regardless of a shared `createdAt`. Freeze `Date.now()` for
      // each paired comparison so both calls see identical elapsed time.
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
      try {
        // Zero active interactions: a million reads score the same as the cap.
        const inflated = (service as any).computeScore(
          noTrending,
          scoreInput(10, { reads: 1_000_000 }),
          weights,
          '24h',
        );
        const atCap = (service as any).computeScore(
          noTrending,
          scoreInput(10, { reads: cap }),
          weights,
          '24h',
        );
        expect(inflated).toBeCloseTo(atCap, 10);

        // Active engagement raises the cap, so real interactions unlock more
        // read credit.
        const engaged = (service as any).computeScore(
          noTrending,
          scoreInput(10, { comments: 10, reads: 1_000_000 }),
          weights,
          '24h',
        );
        const engagedAtCap = (service as any).computeScore(
          noTrending,
          scoreInput(10, { comments: 10, reads: cap * 11 }),
          weights,
          '24h',
        );
        expect(engaged).toBeCloseTo(engagedAtCap, 10);
        expect(engaged).toBeGreaterThan(inflated);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('applies bounded, deterministic tie rotation per post id', () => {
      const svc = service as any;
      const first = svc.computeTieRotation('post-a');
      const second = svc.computeTieRotation('post-a');
      const other = svc.computeTieRotation('post-b');

      expect(first).toBe(second);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(POPULAR_RANKING_CONFIG.TIE_ROTATION_EPSILON);
      expect(other).not.toBe(first);
      expect(svc.computeTieRotation(undefined)).toBe(0);
    });

    it('counts every emoji, not just the first match', () => {
      const svc = service as any;
      expect(svc.countEmojis('nice 😀 post 😀 with 😀 five 😀 emojis 😀')).toBe(
        5,
      );
      expect(svc.countEmojis('plain text with 123 #hash and *star')).toBe(0);
      // ZWJ sequences count per pictographic component, variation-selector
      // emoji count once — both nonzero so the ratio penalty can trigger.
      expect(svc.countEmojis('👨‍👩‍👧')).toBe(3);
      expect(svc.countEmojis('❤️')).toBe(1);
    });

    it('computes velocity from recent interactions capped at the velocity window', () => {
      const svc = service as any;
      const window = POPULAR_RANKING_CONFIG.VELOCITY_WINDOW_HOURS;

      // Old post: divisor is the velocity window, not the post age.
      expect(
        svc.computeInteractionsPerHour(
          scoreInput(200, { recentInteractions: window * 2 }),
          'all',
        ),
      ).toBeCloseTo(2);

      // Very young post: divisor clamps to 1 hour so a burst in the first
      // minutes is not multiplied into an absurd hourly rate.
      expect(
        svc.computeInteractionsPerHour(
          scoreInput(0.1, { recentInteractions: 5 }),
          '24h',
        ),
      ).toBeCloseTo(5);

      // No recent data (plugin items): lifetime-average fallback.
      expect(
        svc.computeInteractionsPerHour(scoreInput(2, { comments: 4 }), '24h'),
      ).toBeCloseTo(2);
    });

    it('scores the all window safely when createdAt is missing or invalid', () => {
      const weights = (service as any).resolveWeights();
      for (const createdAt of [undefined, 'not-a-date']) {
        const score = (service as any).computeScore(
          noTrending,
          { ...scoreInput(1, { comments: 5 }), createdAt },
          weights,
          'all',
        );
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
      }
    });

    it('returns zero tie rotation for missing or empty ids', () => {
      const svc = service as any;
      expect(svc.computeTieRotation(undefined)).toBe(0);
      expect(svc.computeTieRotation('')).toBe(0);
    });

    it('holds full freshness for the boost plateau then fades to zero', () => {
      const svc = service as any;
      const full = POPULAR_RANKING_CONFIG.FRESHNESS_FULL_BOOST_HOURS;
      const zero = POPULAR_RANKING_CONFIG.FRESHNESS_BOOST_HOURS;

      // Anywhere inside the plateau the factor is a flat 1.
      expect(svc.computeFreshnessFactor(scoreInput(1))).toBeCloseTo(1);
      expect(svc.computeFreshnessFactor(scoreInput(full - 1))).toBeCloseTo(1);
      // Midway through the fade it is partial, and it hits 0 at the window end.
      const mid = svc.computeFreshnessFactor(scoreInput((full + zero) / 2));
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
      expect(svc.computeFreshnessFactor(scoreInput(zero + 1))).toBe(0);
    });

    it('demotes stale posts by age unless recent activity revives them', () => {
      const svc = service as any;
      const start = POPULAR_RANKING_CONFIG.STALE_PENALTY_START_HOURS;
      const ramp = POPULAR_RANKING_CONFIG.STALE_PENALTY_RAMP_HOURS;
      const max = POPULAR_RANKING_CONFIG.STALE_PENALTY_MAX;

      // Inside the freshness window: never penalized.
      expect(
        svc.computeStalePenalty(
          scoreInput(start - 10, { recentInteractions: 0 }),
        ),
      ).toBe(0);
      // Past the window with no recent activity: penalty grows with age...
      const younger = svc.computeStalePenalty(
        scoreInput(start + ramp / 4, { recentInteractions: 0 }),
      );
      const older = svc.computeStalePenalty(
        scoreInput(start + ramp / 2, { recentInteractions: 0 }),
      );
      expect(older).toBeGreaterThan(younger);
      expect(younger).toBeGreaterThan(0);
      // ...and is capped.
      expect(
        svc.computeStalePenalty(
          scoreInput(start + ramp * 10, { recentInteractions: 0 }),
        ),
      ).toBeCloseTo(max);
      // Recent activity revives the post; unknown activity (plugin items) is
      // never penalized.
      expect(
        svc.computeStalePenalty(
          scoreInput(start + ramp, { recentInteractions: 1 }),
        ),
      ).toBe(0);
      expect(svc.computeStalePenalty(scoreInput(start + ramp))).toBe(0);
    });

    it('applies bounded, seed-deterministic shuffle jitter', () => {
      const svc = service as any;
      const mag = POPULAR_RANKING_CONFIG.SHUFFLE_MAGNITUDE;

      // Same (id, seed) always lands on the same jitter, so every page of a
      // session agrees on the order; a new seed re-rolls it.
      expect(svc.computeShuffleJitter('post-a', 'seed-1')).toBe(
        svc.computeShuffleJitter('post-a', 'seed-1'),
      );
      expect(svc.computeShuffleJitter('post-a', 'seed-2')).not.toBe(
        svc.computeShuffleJitter('post-a', 'seed-1'),
      );
      expect(svc.computeShuffleJitter('post-b', 'seed-1')).not.toBe(
        svc.computeShuffleJitter('post-a', 'seed-1'),
      );
      expect(
        Math.abs(svc.computeShuffleJitter('post-a', 'seed-1')),
      ).toBeLessThanOrEqual(mag);
      expect(svc.computeShuffleJitter('', 'seed-1')).toBe(0);
    });

    it('reorders a cached ranking only when a seed is supplied', () => {
      const svc = service as any;
      const entries: Array<[string, number]> = Array.from(
        { length: 40 },
        (_, i) => [`post-${i}`, 100 - i],
      );
      const byScore = (e: [string, number]) => e[1];
      const byId = (e: [string, number]) => e[0];

      // No seed: pure score order, untouched.
      expect(
        svc.shuffleScoredEntries(entries, undefined, byId, byScore),
      ).toEqual(entries);

      // Seeded: same members, reordered, and stable across calls.
      const shuffled = svc.shuffleScoredEntries(
        entries,
        'seed-1',
        byId,
        byScore,
      );
      expect(shuffled).not.toEqual(entries);
      expect([...shuffled].sort()).toEqual([...entries].sort());
      expect(
        svc.shuffleScoredEntries(entries, 'seed-1', byId, byScore),
      ).toEqual(shuffled);
      expect(
        svc.shuffleScoredEntries(entries, 'seed-2', byId, byScore),
      ).not.toEqual(shuffled);
    });

    it('penalizes short emoji-only posts in content quality', () => {
      const svc = service as any;
      expect(svc.computeContentQuality('😂😂😂😂😂')).toBeLessThan(
        svc.computeContentQuality('hello'),
      );
    });

    it('scores non-Latin posts on par with Latin ones of the same length', () => {
      // The alphanumeric ratio used an ASCII-only class, so a wholly Chinese,
      // Arabic or Cyrillic post scored 0 on that term and ranked below an
      // otherwise identical Latin post.
      const svc = service as any;
      const latin = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const baseline = svc.computeContentQuality(latin);

      for (const content of [
        '汉'.repeat(latin.length),
        'م'.repeat(latin.length),
        'п'.repeat(latin.length),
      ]) {
        expect(svc.computeContentQuality(content)).toBeCloseTo(baseline, 10);
      }
    });

    it('still discounts a post of pure punctuation', () => {
      const svc = service as any;
      expect(svc.computeContentQuality('!'.repeat(30))).toBeLessThan(
        svc.computeContentQuality('a'.repeat(30)),
      );
    });
  });

  describe('scheduled refresh locking', () => {
    let recomputeSpy: jest.SpyInstance;

    beforeEach(() => {
      redisMock.set.mockReset();
      recomputeSpy = jest
        .spyOn(service as any, 'awaitOrTriggerRecompute')
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      recomputeSpy.mockRestore();
      redisMock.set.mockResolvedValue('OK');
    });

    it('recomputes when the per-window lock is acquired', async () => {
      redisMock.set.mockResolvedValue('OK');

      await service.refreshPopularAll();

      expect(redisMock.set).toHaveBeenCalledWith(
        'popular:refresh-lock:all',
        '1',
        'EX',
        expect.any(Number),
        'NX',
      );
      expect(recomputeSpy).toHaveBeenCalledWith('all');
    });

    it('skips the tick when another instance holds the lock', async () => {
      redisMock.set.mockResolvedValue(null);

      await service.refreshPopularAll();

      expect(recomputeSpy).not.toHaveBeenCalled();
    });

    it('skips the tick when Redis is unreachable', async () => {
      redisMock.set.mockRejectedValue(new Error('redis down'));

      await service.refreshPopularAll();

      expect(recomputeSpy).not.toHaveBeenCalled();
    });

    it('uses a lock TTL below the all-window refresh interval', async () => {
      redisMock.set.mockResolvedValue('OK');

      await service.refreshPopularAll();

      const ttl = redisMock.set.mock.calls[0][3];
      expect(ttl).toBeLessThan(600);
    });

    // Guards against re-introducing the wasted work: GET /posts/popular is
    // all-time only, so nothing reads the 24h/7d caches and they must not be
    // recomputed on a schedule.
    it('does not schedule recomputes for the deprecated 24h/7d windows', () => {
      const svc = service as unknown as Record<string, unknown>;
      expect(svc.refreshPopular24h).toBeUndefined();
      expect(svc.refreshPopular7d).toBeUndefined();
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
      const candidateQB = createCandidateQueryBuilder([post]);
      const tipQB = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
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
          createQueryBuilder: jest.fn().mockReturnValue(candidateQB),
          query: jest.fn().mockResolvedValue([]),
          find: jest.fn().mockResolvedValue([post]),
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

import { PostsController } from './posts.controller';
import { paginate } from 'nestjs-typeorm-paginate';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('PostsController', () => {
  let controller: PostsController;
  let postRepository: {
    createQueryBuilder: jest.Mock;
  };
  let baseQueryBuilder: {
    leftJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    orderBy: jest.Mock;
    offset: jest.Mock;
    limit: jest.Mock;
    getRawMany: jest.Mock;
  };
  let emptyResultQueryBuilder: {
    where: jest.Mock;
  };

  beforeEach(() => {
    baseQueryBuilder = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    emptyResultQueryBuilder = {
      where: jest.fn().mockReturnThis(),
    };

    postRepository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(baseQueryBuilder)
        .mockReturnValueOnce(emptyResultQueryBuilder),
    };

    controller = new PostsController(
      postRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('applies search to post content and topic names', async () => {
    await controller.listAll(1, 100, 'created_at', 'DESC', 'governance');

    expect(baseQueryBuilder.andWhere).toHaveBeenCalledWith(
      '(post.content ILIKE :searchTerm OR topic.name ILIKE :searchTerm)',
      { searchTerm: '%governance%' },
    );
    expect(paginate).toHaveBeenCalledWith(emptyResultQueryBuilder, {
      page: 1,
      limit: 100,
    });
  });

  it('uses all-time ranking for popular posts and ignores legacy window queries', async () => {
    const popularPost = {
      id: 'post-popular',
      sender_address: 'ak_author',
      created_at: new Date().toISOString(),
      content: 'popular post',
      total_comments: 0,
    };
    const popularRankingService = {
      getPopularPostsPage: jest.fn().mockResolvedValue({
        items: [popularPost],
        totalItems: 1,
      }),
    };
    const hydratedPostQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([popularPost]),
    };
    const popularController = new PostsController(
      {
        createQueryBuilder: jest.fn().mockReturnValue(hydratedPostQueryBuilder),
      } as any,
      {} as any,
      popularRankingService as any,
      {} as any,
      {
        getProfilesByAddresses: jest.fn().mockResolvedValue([]),
      } as any,
    );

    await popularController.popular({
      page: 1,
      limit: 20,
      window: '24h',
    } as any);

    expect(popularRankingService.getPopularPostsPage).toHaveBeenCalledWith(
      'all',
      20,
      0,
      undefined,
      expect.any(Object),
    );
  });

  describe('trend mention performance', () => {
    const attachTrendMentions = (
      items: Array<{ id: string; content: string }>,
      tokens: Array<Record<string, any>>,
    ) => {
      const tokenQueryBuilder = {
        leftJoinAndMapOne: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(tokens),
      };
      const tokenRepository = {
        createQueryBuilder: jest.fn().mockReturnValue(tokenQueryBuilder),
      };
      const trendController = new PostsController(
        {} as any,
        tokenRepository as any,
        {} as any,
        {} as any,
        {} as any,
      );

      return {
        tokenQueryBuilder,
        run: () =>
          (trendController as any).attachTrendMentionsPerformance(items),
      };
    };

    it('resolves a hashtag naming a token from a non-Latin collection', async () => {
      const items = [{ id: 'post-1', content: 'accumulating #汉字 早期' }];
      const { tokenQueryBuilder, run } = attachTrendMentions(items, [
        { symbol: '汉字', sale_address: 'ct_chinese', performance: { pct: 1 } },
      ]);

      await run();

      expect(tokenQueryBuilder.andWhere).toHaveBeenCalledWith(
        'UPPER(token.symbol) IN (:...names)',
        { names: ['汉字'] },
      );
      expect((items[0] as any).trend_mentions).toEqual([
        {
          name: '汉字',
          sale_address: 'ct_chinese',
          performance: { pct: 1 },
        },
      ]);
    });

    it('resolves a lowercase Cyrillic hashtag onto the uppercase symbol', async () => {
      const items = [{ id: 'post-2', content: 'держим #привет' }];
      const { tokenQueryBuilder, run } = attachTrendMentions(items, [
        { symbol: 'ПРИВЕТ', sale_address: 'ct_russian', performance: null },
      ]);

      await run();

      expect(tokenQueryBuilder.andWhere).toHaveBeenCalledWith(
        'UPPER(token.symbol) IN (:...names)',
        { names: ['ПРИВЕТ'] },
      );
      expect((items[0] as any).trend_mentions).toEqual([
        { name: 'ПРИВЕТ', sale_address: 'ct_russian', performance: null },
      ]);
    });

    it('resolves Latin and non-Latin hashtags in the same post', async () => {
      const items = [{ id: 'post-3', content: 'swapping #WORDS-1 for #汉字' }];
      const { run } = attachTrendMentions(items, [
        { symbol: 'WORDS-1', sale_address: 'ct_words', performance: null },
        { symbol: '汉字', sale_address: 'ct_chinese', performance: null },
      ]);

      await run();

      expect((items[0] as any).trend_mentions).toEqual([
        { name: 'WORDS-1', sale_address: 'ct_words', performance: null },
        { name: '汉字', sale_address: 'ct_chinese', performance: null },
      ]);
    });

    it('reports a mention with no matching token as an unresolved trend', async () => {
      const items = [{ id: 'post-4', content: 'hyping #汉字' }];
      const { run } = attachTrendMentions(items, []);

      await run();

      expect((items[0] as any).trend_mentions).toEqual([
        { name: '汉字', sale_address: null, performance: null },
      ]);
    });
  });
});

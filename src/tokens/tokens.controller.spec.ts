import { Test, TestingModule } from '@nestjs/testing';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Token, UNRANKED_TOKEN_RANK } from './entities/token.entity';
import { TokenHolder } from './entities/token-holders.entity';
import { paginate } from 'nestjs-typeorm-paginate';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Reflector } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bull';
import { SYNC_TOKEN_HOLDERS_QUEUE } from './queues/constants';

jest.mock('nestjs-typeorm-paginate', () => ({
  paginate: jest.fn().mockResolvedValue({ items: [], meta: {} }),
}));

describe('TokensController', () => {
  let controller: TokensController;
  let tokensService: TokensService;
  let communityFactoryService: CommunityFactoryService;
  let tokensRepository: Repository<Token>;
  let tokenHolderRepository: Repository<TokenHolder>;
  let cacheManager: {
    get: jest.Mock;
    set: jest.Mock;
  };
  let tokenHolderQueryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    select: jest.Mock;
    orderBy: jest.Mock;
    distinct: jest.Mock;
    getCount: jest.Mock;
    getRawMany: jest.Mock;
  };
  let tokensQueryBuilder: {
    select: jest.Mock;
    orderBy: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    andWhereInIds: jest.Mock;
    getCount: jest.Mock;
    getMany: jest.Mock;
  };

  beforeEach(async () => {
    tokensQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      andWhereInIds: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(2),
      getMany: jest.fn().mockResolvedValue([]),
    };

    const tokensRepositoryMock = {
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => tokensQueryBuilder),
    };

    tokenHolderQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(2),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    const tokenHolderRepositoryMock = {
      createQueryBuilder: jest.fn(() => tokenHolderQueryBuilder),
    };
    cacheManager = {
      get: jest.fn(),
      set: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TokensController],
      providers: [
        {
          provide: CACHE_MANAGER,
          useValue: cacheManager,
        },
        {
          provide: Reflector,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Token),
          useValue: tokensRepositoryMock,
        },
        {
          provide: getRepositoryToken(TokenHolder),
          useValue: tokenHolderRepositoryMock,
        },
        {
          provide: getQueueToken(SYNC_TOKEN_HOLDERS_QUEUE),
          useValue: {
            add: jest.fn(),
          },
        },
        {
          provide: TokensService,
          useValue: {
            applyListEligibilityFilters: jest.fn(),
            getToken: jest.fn().mockResolvedValue({
              id: 1,
              rank: 5,
              total_supply: { toNumber: () => 1000000 },
              factory_address: 'ct_123',
            }),
            findByAddress: jest.fn().mockResolvedValue({
              id: 1,
              address: 'ct_123',
              rank: 5,
              total_supply: { toNumber: () => 1000000 },
              factory_address: 'ct_123',
            }),
            queryTokensWithRanks: jest
              .fn()
              .mockResolvedValue({ items: [], meta: {} }),
            updateTokenTrendingScore: jest.fn().mockResolvedValue({
              metrics: { trending_score: { result: 0.5 } },
              token: { sale_address: 'ct_123', trending_score: 0.5 },
            }),
            getTrendingEligibilityBreakdown: jest.fn().mockResolvedValue({
              sale_address: 'ct_123',
              symbol: 'TEST',
              holders_count: 6,
              post_count: 3,
              stored_post_count: 1,
              content_post_count: 2,
              trade_count: 4,
              thresholds: {
                min_holders: 5,
                min_posts: 2,
                min_trades: 3,
              },
              passes: {
                holders: true,
                posts: true,
                trades: true,
                eligible: true,
              },
            }),
          },
        },
        {
          provide: CommunityFactoryService,
          useValue: {
            getCurrentFactory: jest
              .fn()
              .mockResolvedValue({ address: 'ct_123', collections: {} }),
            mapCollectionInfo: jest.fn().mockReturnValue(null),
          },
        },
      ],
    }).compile();

    controller = module.get<TokensController>(TokensController);
    tokensService = module.get<TokensService>(TokensService);
    communityFactoryService = module.get<CommunityFactoryService>(
      CommunityFactoryService,
    );
    tokensRepository = module.get<Repository<Token>>(getRepositoryToken(Token));
    tokenHolderRepository = module.get<Repository<TokenHolder>>(
      getRepositoryToken(TokenHolder),
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return paginated list of tokens', async () => {
    const result = await controller.listAll();
    expect(tokensService.applyListEligibilityFilters).not.toHaveBeenCalled();
    expect(tokensService.queryTokensWithRanks).toHaveBeenCalled();
    expect(result).toEqual({ items: [], meta: {} });
  });

  it('should apply search to token names', async () => {
    await controller.listAll('alice');

    expect(tokensQueryBuilder.andWhere).toHaveBeenCalledWith(
      'token.name ILIKE :search',
      { search: '%alice%' },
    );
    expect(tokensService.queryTokensWithRanks).toHaveBeenCalledWith(
      tokensQueryBuilder,
      100,
      1,
      'market_cap',
      'DESC',
    );
  });

  it('should allow ordering tokens by treasury', async () => {
    await controller.listAll(
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      100,
      'treasury',
      'DESC',
      'all',
    );

    expect(tokensService.applyListEligibilityFilters).not.toHaveBeenCalled();
    expect(tokensService.queryTokensWithRanks).toHaveBeenCalledWith(
      tokensQueryBuilder,
      100,
      1,
      'treasury',
      'DESC',
    );
  });

  it('rejects invalid token list pagination and search before querying', async () => {
    await expect(
      controller.listAll(undefined, undefined, undefined, undefined, 0, 100),
    ).rejects.toThrow('Page must be greater than or equal to 1');
    await expect(
      controller.listAll(undefined, undefined, undefined, undefined, 1, 101),
    ).rejects.toThrow('Limit must be between 1 and 100');
    await expect(controller.listAll('x'.repeat(101))).rejects.toThrow(
      'search must be at most 100 characters',
    );

    expect(tokensService.queryTokensWithRanks).not.toHaveBeenCalled();
  });

  it('should filter owner holdings with EXISTS instead of a distinct IN subquery', async () => {
    await controller.listAll(undefined, undefined, undefined, 'ak_owner');

    expect(tokensQueryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('EXISTS ('),
      { owner_address: 'ak_owner' },
    );
    expect(tokensQueryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('token_holder.aex9_address = token.address'),
      { owner_address: 'ak_owner' },
    );
  });

  it('should apply eligibility filters only for trending score ordering', async () => {
    await controller.listAll(
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      100,
      'trending_score',
      'DESC',
      'all',
    );

    expect(tokensService.applyListEligibilityFilters).toHaveBeenCalled();
    expect(cacheManager.get).toHaveBeenCalled();
    expect(cacheManager.set).toHaveBeenCalled();
  });

  it('should return cached trending-score token lists', async () => {
    cacheManager.get.mockResolvedValueOnce({
      items: [{ sale_address: 'ct_a', collection: 'CHINESE-ak_x' }],
      meta: {},
    });

    const result = await controller.listAll(
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      100,
      'trending_score',
      'DESC',
      'all',
    );

    expect((result as any).items[0].sale_address).toBe('ct_a');
    expect(tokensService.applyListEligibilityFilters).not.toHaveBeenCalled();
    expect(tokensService.queryTokensWithRanks).not.toHaveBeenCalled();
  });

  it('enriches cached trending-score token lists with collection_info on read', async () => {
    // Simulate an entry cached before collection_info existed: it lacks the
    // field, but the hit path must still resolve and attach it.
    cacheManager.get.mockResolvedValueOnce({
      items: [{ sale_address: 'ct_a', collection: 'CHINESE-ak_x' }],
      meta: {},
    });
    const collectionInfo = {
      id: 'CHINESE-ak_x',
      name: 'CHINESE',
      description: 'Chinese collection',
      allowed_name_length: '20',
    };
    (communityFactoryService.mapCollectionInfo as jest.Mock).mockReturnValue(
      collectionInfo,
    );

    const result = await controller.listAll(
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      100,
      'trending_score',
      'DESC',
      'all',
    );

    expect(tokensService.queryTokensWithRanks).not.toHaveBeenCalled();
    expect(communityFactoryService.mapCollectionInfo).toHaveBeenCalledWith(
      expect.anything(),
      'CHINESE-ak_x',
    );
    expect((result as any).items[0].collection_info).toEqual(collectionInfo);
  });

  it('should not collide trending cache keys when filter values contain separators', async () => {
    await controller.listAll(
      'a:b',
      undefined,
      undefined,
      undefined,
      1,
      100,
      'trending_score',
      'DESC',
      'all',
    );
    await controller.listAll(
      'a',
      'b',
      undefined,
      undefined,
      1,
      100,
      'trending_score',
      'DESC',
      'all',
    );

    expect(cacheManager.get).toHaveBeenCalledTimes(2);
    const firstKey = cacheManager.get.mock.calls[0][0];
    const secondKey = cacheManager.get.mock.calls[1][0];

    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toContain('"search":"a:b"');
    expect(firstKey).toContain('"factory_address":""');
    expect(secondKey).toContain('"search":"a"');
    expect(secondKey).toContain('"factory_address":"b"');
  });

  it('should return token details by address', async () => {
    const result = await controller.findByAddress('ct_123');
    expect(tokensService.getToken).toHaveBeenCalledWith('ct_123');
    expect(result).toEqual({
      id: 1,
      rank: 5,
      total_supply: { toNumber: expect.any(Function) },
      factory_address: 'ct_123',
      collection_info: null,
    });
  });

  it('should return trending eligibility breakdown for a token', async () => {
    const result = await controller.getTrendingEligibility('ct_123');

    expect(tokensService.getTrendingEligibilityBreakdown).toHaveBeenCalledWith(
      'ct_123',
    );
    expect(result).toEqual({
      sale_address: 'ct_123',
      symbol: 'TEST',
      holders_count: 6,
      post_count: 3,
      stored_post_count: 1,
      content_post_count: 2,
      trade_count: 4,
      thresholds: {
        min_holders: 5,
        min_posts: 2,
        min_trades: 3,
      },
      passes: {
        holders: true,
        posts: true,
        trades: true,
        eligible: true,
      },
    });
  });

  it('should return paginated list of token holders', async () => {
    const result = await controller.listTokenHolders('ct_123');
    expect(tokensService.findByAddress).toHaveBeenCalledWith('ct_123', true);
    expect(tokenHolderQueryBuilder.andWhere).toHaveBeenCalledWith(
      'token_holder.balance > 0',
    );
    expect(paginate).toHaveBeenCalled();
    expect(result).toEqual({ items: [], meta: {} });
  });

  it('should throw when listing holders for an unknown token', async () => {
    const createQueryBuilderSpy = jest.spyOn(
      tokenHolderRepository,
      'createQueryBuilder',
    );
    tokensService.findByAddress = jest.fn().mockResolvedValue(null);

    await expect(controller.listTokenHolders('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(createQueryBuilderSpy).not.toHaveBeenCalled();
  });

  it('should return paginated token rankings', async () => {
    const result = await controller.listTokenRankings('ct_123');
    expect(tokensService.findByAddress).toHaveBeenCalledWith('ct_123', true);
    // Anchored on the token's own rank, not a rank range.
    expect(tokensRepository.query).toHaveBeenCalledWith(expect.any(String), [
      'ct_123',
      5,
      5,
    ]);
    expect(result).toEqual({
      items: [],
      meta: {
        currentPage: 1,
        itemCount: 0,
        itemsPerPage: 5,
        totalItems: 0,
        totalPages: 1,
      },
    });
  });

  it('centres the window on the token and fills from both sides', async () => {
    tokensService.findByAddress = jest.fn().mockResolvedValue({
      sale_address: 'ct_123',
      rank: 10,
      factory_address: 'ct_123',
    });
    jest.spyOn(tokensRepository, 'query').mockResolvedValue([
      { sale_address: 'a', rank: 8 },
      { sale_address: 'b', rank: 9 },
      { sale_address: 'c', rank: 10 },
      { sale_address: 'd', rank: 11 },
      { sale_address: 'e', rank: 12 },
    ]);

    const result = await controller.listTokenRankings('ct_123');

    // floor(5/2) = 2 above, the target, then 2 below -- ascending by rank.
    expect(result.items.map((item: any) => item.rank)).toEqual([
      8, 9, 10, 11, 12,
    ]);
  });

  it('still returns a full page when ranks inside the window are unoccupied', async () => {
    tokensService.findByAddress = jest.fn().mockResolvedValue({
      sale_address: 'ct_123',
      rank: 10,
      factory_address: 'ct_123',
    });
    // Ranks 8, 9 and 11 belong to tokens this board does not contain -- a
    // BETWEEN 8 AND 12 window would have returned two rows.
    jest.spyOn(tokensRepository, 'query').mockResolvedValue([
      { sale_address: 'a', rank: 3 },
      { sale_address: 'b', rank: 6 },
      { sale_address: 'c', rank: 10 },
      { sale_address: 'd', rank: 12 },
      { sale_address: 'e', rank: 17 },
    ]);

    const result = await controller.listTokenRankings('ct_123');

    expect(result.items.map((item: any) => item.rank)).toEqual([
      3, 6, 10, 12, 17,
    ]);
    expect(result.meta.itemCount).toBe(5);
  });

  it('should clamp the ranking window at the top of the board', async () => {
    tokensService.findByAddress = jest.fn().mockResolvedValue({
      sale_address: 'ct_123',
      rank: 1,
      factory_address: 'ct_123',
    });
    jest.spyOn(tokensRepository, 'query').mockResolvedValue([
      { sale_address: 'c', rank: 1 },
      { sale_address: 'd', rank: 2 },
      { sale_address: 'e', rank: 3 },
      { sale_address: 'f', rank: 4 },
      { sale_address: 'g', rank: 5 },
    ]);

    const result = await controller.listTokenRankings('ct_123');

    expect(tokensRepository.query).toHaveBeenCalledWith(expect.any(String), [
      'ct_123',
      1,
      5,
    ]);
    // Nothing above rank 1, so every slot is spent below it.
    expect(result.items.map((item: any) => item.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives a token from another factory no neighbours on this board', async () => {
    tokensService.findByAddress = jest.fn().mockResolvedValue({
      sale_address: 'ct_other',
      rank: 4,
      factory_address: 'ct_previous_factory',
    });
    const querySpy = jest.spyOn(tokensRepository, 'query');
    querySpy.mockClear();

    const result = await controller.listTokenRankings('ct_other');

    // Its global rank lands inside this board, so a rank window would have
    // handed back the current factory's tokens as its peers.
    expect(querySpy).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.meta.totalItems).toBe(0);
  });

  it('gives an unlisted token no neighbours', async () => {
    tokensService.findByAddress = jest.fn().mockResolvedValue({
      sale_address: 'ct_123',
      rank: 4,
      factory_address: 'ct_123',
      unlisted: true,
    });
    const querySpy = jest.spyOn(tokensRepository, 'query');
    querySpy.mockClear();

    const result = await controller.listTokenRankings('ct_123');

    expect(querySpy).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
  });

  it('should not query neighbours for a token that has no rank yet', async () => {
    tokensService.findByAddress = jest
      .fn()
      .mockResolvedValue({ sale_address: 'ct_123', rank: UNRANKED_TOKEN_RANK });
    const querySpy = jest.spyOn(tokensRepository, 'query');
    querySpy.mockClear();

    const result = await controller.listTokenRankings('ct_123');

    expect(querySpy).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.meta.totalItems).toBe(0);
  });

  it('should return an updated token score breakdown', async () => {
    const result = await controller.getTokenScore('ct_123');

    expect(tokensService.findByAddress).toHaveBeenCalledWith('ct_123');
    expect(tokensService.updateTokenTrendingScore).toHaveBeenCalledWith({
      id: 1,
      address: 'ct_123',
      rank: 5,
      total_supply: { toNumber: expect.any(Function) },
      factory_address: 'ct_123',
    });
    expect(result).toEqual({
      metrics: { trending_score: { result: 0.5 } },
      token: { sale_address: 'ct_123', trending_score: 0.5 },
    });
  });

  it('should throw when requesting score for an unknown token', async () => {
    tokensService.findByAddress = jest.fn().mockResolvedValue(null);

    await expect(controller.getTokenScore('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tokensService.updateTokenTrendingScore).not.toHaveBeenCalled();
  });
});

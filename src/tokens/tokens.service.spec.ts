import { NotFoundException } from '@nestjs/common';
import {
  TOKEN_LIST_ELIGIBILITY_CONFIG,
  TRENDING_SCORE_CONFIG,
} from '@/configs/constants';
import { TokensService } from './tokens.service';

describe('TokensService', () => {
  let service: TokensService;
  let tokensRepository: any;
  let transactionsRepository: any;
  let postsRepository: any;
  let tokenEligibilityCountsRepository: any;
  let communityFactoryService: any;
  let pullTokenInfoQueue: any;

  beforeEach(() => {
    tokensRepository = {
      createQueryBuilder: jest.fn(),
      update: jest.fn(),
      query: jest.fn(),
      upsert: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      findOneBy: jest.fn(),
    };
    transactionsRepository = {
      query: jest.fn(),
    };
    postsRepository = {
      query: jest.fn(),
    };
    tokenEligibilityCountsRepository = {
      findOne: jest.fn(),
    };
    communityFactoryService = {
      getCurrentFactory: jest.fn(),
    };
    pullTokenInfoQueue = {
      add: jest.fn(),
    };

    service = new TokensService(
      tokensRepository as any,
      {} as any,
      transactionsRepository as any,
      postsRepository as any,
      tokenEligibilityCountsRepository as any,
      {} as any,
      {} as any,
      {} as any,
      communityFactoryService as any,
      pullTokenInfoQueue as any,
    );
  });

  it('calculates zero score cleanly when all signals are zero', async () => {
    transactionsRepository.query.mockResolvedValue([
      {
        active_wallets: '0',
        buy_count: '0',
        sell_count: '0',
        volume_ae: '0',
        last_trade_at: null,
      },
    ]);
    postsRepository.query.mockResolvedValue([
      {
        mention_posts: '0',
        mention_comments: '0',
        unique_authors: '0',
        tips_count: '0',
        tips_amount_ae: '0',
        reads: '0',
        last_social_activity_at: null,
      },
    ]);

    const metrics = await service.calculateTokenTrendingMetrics({
      sale_address: 'ct_sale',
      symbol: 'TEST',
    } as any);

    expect(metrics.component_scores.pre_decay).toBe(0);
    expect(metrics.decay_multiplier).toBe(0);
    expect(metrics.trending_score.result).toBe(0);
    expect(metrics.age_hours_since_last_activity).toBe(
      TRENDING_SCORE_CONFIG.WINDOW_HOURS,
    );
  });

  it('uses the latest social activity timestamp for decay', async () => {
    const olderTrade = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const newerSocial = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    transactionsRepository.query.mockResolvedValue([
      {
        active_wallets: '3',
        buy_count: '2',
        sell_count: '1',
        volume_ae: '20',
        last_trade_at: olderTrade,
      },
    ]);
    postsRepository.query.mockResolvedValue([
      {
        mention_posts: '2',
        mention_comments: '1',
        unique_authors: '2',
        tips_count: '1',
        tips_amount_ae: '5',
        reads: '10',
        last_social_activity_at: newerSocial,
      },
    ]);

    const metrics = await service.calculateTokenTrendingMetrics({
      sale_address: 'ct_sale',
      symbol: 'TEST',
    } as any);

    expect(metrics.last_activity_at?.toISOString()).toBe(newerSocial);
    expect(metrics.age_hours_since_last_activity).toBeLessThan(2);
    expect(metrics.trending_score.result).toBeGreaterThan(0);
  });

  it('excludes self-tips from token social tip inputs', async () => {
    transactionsRepository.query.mockResolvedValue([
      {
        active_wallets: '0',
        buy_count: '0',
        sell_count: '0',
        volume_ae: '0',
        last_trade_at: null,
      },
    ]);
    postsRepository.query.mockResolvedValue([
      {
        mention_posts: '0',
        mention_comments: '0',
        unique_authors: '0',
        tips_count: '0',
        tips_amount_ae: '0',
        reads: '0',
        last_social_activity_at: null,
      },
    ]);

    await service.calculateTokenTrendingMetrics({
      sale_address: 'ct_sale',
      symbol: 'TEST',
    } as any);

    const [socialQuery] = postsRepository.query.mock.calls[0];

    expect(socialQuery).toContain(
      'INNER JOIN posts tipped_post ON tipped_post.id = tip.post_id',
    );
    expect((socialQuery.match(/tip\.sender_address != tipped_post\.sender_address/g) || []).length).toBe(3);
  });

  it('throws a not found error when updating a missing token', async () => {
    await expect(service.updateTokenTrendingScore(null as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('persists zero when the calculated score is non-finite', async () => {
    jest
      .spyOn(service, 'calculateTokenTrendingMetrics')
      .mockResolvedValue({
        trending_score: {
          result: Number.NaN,
        },
      } as any);

    const result = await service.updateTokenTrendingScore({
      sale_address: 'ct_sale',
      symbol: 'TEST',
    } as any);

    expect(tokensRepository.update).toHaveBeenCalledWith('ct_sale', {
      trending_score: 0,
      trending_score_update_at: expect.any(Date),
    });
    expect(result.token.trending_score).toBe(0);
  });

  it('normalizes symbols before refreshing scores by symbol', async () => {
    const getMany = jest.fn().mockResolvedValue([{ sale_address: 'ct_sale' }]);
    const andWhere = jest.fn().mockReturnValue({ getMany });
    tokensRepository.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnValue({
        andWhere,
      }),
    });
    jest
      .spyOn(service, 'updateMultipleTokensTrendingScores')
      .mockResolvedValue(undefined);

    await service.updateTrendingScoresForSymbols([' test ', 'TEST', '', 'alpha']);

    expect(andWhere).toHaveBeenCalledWith('UPPER(token.symbol) IN (:...symbols)', {
      symbols: ['TEST', 'ALPHA'],
    });
    expect(service.updateMultipleTokensTrendingScores).toHaveBeenCalledWith([
      { sale_address: 'ct_sale' },
    ]);
  });

  it('limits concurrent batch updates', async () => {
    let active = 0;
    let maxActive = 0;

    jest.spyOn(service, 'updateTokenTrendingScore').mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        metrics: {} as any,
        token: {} as any,
      };
    });

    await service.updateMultipleTokensTrendingScores(
      Array.from({ length: 20 }, (_, index) => ({
        sale_address: `ct_${index}`,
      })) as any,
    );

    expect(maxActive).toBeLessThanOrEqual(
      TRENDING_SCORE_CONFIG.MAX_CONCURRENT_UPDATES,
    );
  });

  it('applies token list eligibility thresholds to the query builder', () => {
    const leftJoin = jest.fn().mockReturnThis();
    const andWhere = jest.fn().mockReturnThis();
    const queryBuilder = { leftJoin, andWhere } as any;

    const result = service.applyListEligibilityFilters(queryBuilder);
    const [postCountsSql, postCountsAlias, postCountsCondition] =
      leftJoin.mock.calls[0];
    const [tradeCountsSql, tradeCountsAlias, tradeCountsCondition] =
      leftJoin.mock.calls[1];
    const [eligibilitySql, eligibilityParams] = andWhere.mock.calls[0];

    expect(result).toBe(queryBuilder);
    expect(leftJoin).toHaveBeenCalledTimes(2);
    expect(postCountsAlias).toBe('eligibility_post_counts');
    expect(postCountsSql.name).toBe('TokenEligibilityCounts');
    expect(postCountsCondition).toBe(
      'eligibility_post_counts.symbol = UPPER(token.symbol)',
    );
    expect(tradeCountsAlias).toBe('eligibility_trade_counts');
    expect(tradeCountsSql.startsWith('(')).toBe(true);
    expect(tradeCountsSql).toContain('COUNT(*) AS trade_count');
    expect(tradeCountsCondition).toBe(
      'eligibility_trade_counts.sale_address = token.sale_address',
    );
    expect(eligibilitySql).toContain(
      'token.holders_count >= :eligibilityMinHolders',
    );
    expect(eligibilitySql).toContain(
      'COALESCE(eligibility_post_counts.post_count, 0) >= :eligibilityMinPosts',
    );
    expect(eligibilitySql).toContain(
      'COALESCE(eligibility_trade_counts.trade_count, 0) >= :eligibilityMinTrades',
    );
    expect(eligibilitySql).not.toContain('SELECT COUNT(*)');
    expect(eligibilityParams).toEqual(
      expect.objectContaining({
        eligibilityMinHolders: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_HOLDERS,
        eligibilityMinPosts:
          TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TOKEN_POSTS_ALL_TIME,
        eligibilityMinTrades:
          TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TRADES_ALL_TIME,
      }),
    );
  });

  it('returns a trending eligibility breakdown for a token', async () => {
    jest.spyOn(service, 'findByAddress').mockResolvedValue({
      sale_address: 'ct_sale',
      symbol: 'TEST',
      holders_count: 6,
    } as any);
    tokenEligibilityCountsRepository.findOne.mockResolvedValue({
      post_count: 3,
      stored_post_count: 1,
      content_post_count: 2,
    });
    tokensRepository.query.mockResolvedValue([
      {
        trade_count: '4',
      },
    ]);

    const breakdown = await service.getTrendingEligibilityBreakdown('ct_sale');

    const [eligibilityQuery, eligibilityParams] = tokensRepository.query.mock.calls[0];
    expect(tokenEligibilityCountsRepository.findOne).toHaveBeenCalledWith({
      where: { symbol: 'TEST' },
    });
    expect(eligibilityQuery).toContain('COUNT(*) AS trade_count');
    expect(eligibilityQuery).toContain('tx.sale_address = $1');
    expect(eligibilityParams).toEqual(['ct_sale']);
    expect(breakdown).toEqual({
      sale_address: 'ct_sale',
      symbol: 'TEST',
      holders_count: 6,
      post_count: 3,
      stored_post_count: 1,
      content_post_count: 2,
      trade_count: 4,
      thresholds: {
        min_holders: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_HOLDERS,
        min_posts: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TOKEN_POSTS_ALL_TIME,
        min_trades: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TRADES_ALL_TIME,
      },
      passes: {
        holders: true,
        posts: true,
        trades: true,
        eligible: true,
      },
    });
  });

  it('falls back cleanly when sale contract lookup returns undefined', async () => {
    jest
      .spyOn(service, 'getTokenContractsBySaleAddress')
      .mockResolvedValue(undefined);

    const holders = await service._loadHoldersFromContract(
      {
        sale_address: 'ct_missing',
      } as any,
      'ct_aex9',
    );

    expect(holders).toEqual([]);
    expect(service.getTokenContractsBySaleAddress).toHaveBeenCalledTimes(1);
  });

  it('uses upsert and reload when creating a token from a raw transaction', async () => {
    communityFactoryService.getCurrentFactory.mockResolvedValue({
      address: 'ct_factory',
      collections: { word: true },
    });
    jest.spyOn(service, 'findByNameOrSymbol').mockResolvedValue(null);
    tokensRepository.findOneBy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        sale_address: 'ct_sale',
        name: 'BLA',
      });

    const token = await service.createTokenFromRawTransaction({
      hash: 'th_hash',
      microTime: '2026-03-24T11:49:27.106Z',
      tx: {
        function: 'create_community',
        return_type: 'ok',
        return: {
          value: [{ value: 'ct_dao' }, { value: 'ct_sale' }],
        },
        arguments: [{ value: 'word' }, { value: 'BLA' }],
        callerId: 'ak_creator',
      },
    });

    expect(tokensRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        dao_address: 'ct_dao',
        sale_address: 'ct_sale',
        factory_address: 'ct_factory',
        creator_address: 'ak_creator',
        name: 'BLA',
        symbol: 'BLA',
        create_tx_hash: 'th_hash',
      }),
      {
        conflictPaths: ['sale_address'],
        skipUpdateIfNoValuesChanged: true,
      },
    );
    expect(tokensRepository.save).not.toHaveBeenCalled();
    expect(pullTokenInfoQueue.add).toHaveBeenCalledWith(
      { saleAddress: 'ct_sale' },
      expect.objectContaining({
        jobId: 'pullTokenInfo-ct_sale',
        lifo: true,
        removeOnComplete: true,
      }),
    );
    expect(token).toEqual({
      sale_address: 'ct_sale',
      name: 'BLA',
    });
  });
});

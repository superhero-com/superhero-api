import { NotFoundException } from '@nestjs/common';
import {
  TOKEN_LIST_ELIGIBILITY_CONFIG,
  TRENDING_SCORE_CONFIG,
} from '@/configs/constants';
import {
  RetryableTokenHoldersSyncError,
  TokensService,
} from './tokens.service';
import { fetchJson } from '@/utils/common';

jest.mock('@/utils/common', () => {
  const actual = jest.requireActual('@/utils/common');
  return {
    ...actual,
    fetchJson: jest.fn(),
  };
});

describe('TokensService', () => {
  let service: TokensService;
  let tokensRepository: any;
  let transactionsRepository: any;
  let postsRepository: any;
  let tokenEligibilityCountsRepository: any;
  let tokenTradeEligibilityCountsRepository: any;
  let communityFactoryService: any;
  let pullTokenInfoQueue: any;
  let updateTrendingScoresQueue: any;

  beforeEach(() => {
    (fetchJson as jest.Mock).mockReset();
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
    tokenTradeEligibilityCountsRepository = {
      findOne: jest.fn(),
    };
    communityFactoryService = {
      getCurrentFactory: jest.fn(),
    };
    pullTokenInfoQueue = {
      add: jest.fn(),
    };
    updateTrendingScoresQueue = {
      add: jest.fn(),
    };

    service = new TokensService(
      tokensRepository as any,
      {} as any,
      transactionsRepository as any,
      postsRepository as any,
      tokenEligibilityCountsRepository as any,
      tokenTradeEligibilityCountsRepository as any,
      {} as any,
      {} as any,
      {} as any,
      communityFactoryService as any,
      pullTokenInfoQueue as any,
      updateTrendingScoresQueue as any,
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
    expect(
      (
        socialQuery.match(
          /tip\.sender_address != tipped_post\.sender_address/g,
        ) || []
      ).length,
    ).toBe(3);
  });

  it('throws a not found error when updating a missing token', async () => {
    await expect(
      service.updateTokenTrendingScore(null as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('persists zero when the calculated score is non-finite', async () => {
    jest.spyOn(service, 'calculateTokenTrendingMetrics').mockResolvedValue({
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

    await service.updateTrendingScoresForSymbols([
      ' test ',
      'TEST',
      '',
      'alpha',
    ]);

    expect(andWhere).toHaveBeenCalledWith(
      'UPPER(token.symbol) IN (:...symbols)',
      {
        symbols: ['TEST', 'ALPHA'],
      },
    );
    expect(service.updateMultipleTokensTrendingScores).toHaveBeenCalledWith([
      { sale_address: 'ct_sale' },
    ]);
  });

  it('limits concurrent batch updates', async () => {
    let active = 0;
    let maxActive = 0;

    jest
      .spyOn(service, 'updateTokenTrendingScore')
      .mockImplementation(async () => {
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
    expect(tradeCountsSql.name).toBe('TokenTradeEligibilityCounts');
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
        eligibilityMinTrades: TOKEN_LIST_ELIGIBILITY_CONFIG.MIN_TRADES_ALL_TIME,
      }),
    );
  });

  it('executes a single query for ranked token pages and preserves pagination metadata', async () => {
    const queryBuilder = {
      getQueryAndParameters: jest
        .fn()
        .mockReturnValue([
          'SELECT token.* FROM token WHERE token.unlisted = false AND token.name ILIKE $1',
          ['%alpha%'],
        ]),
    } as any;

    tokensRepository.query.mockResolvedValue([
      { sale_address: 'ct_1', name: 'Alpha', total_items: 2 },
      { sale_address: 'ct_2', name: 'Beta', total_items: 2 },
    ]);

    const result = await service.queryTokensWithRanks(
      queryBuilder,
      2,
      1,
      'market_cap',
      'DESC',
    );

    expect(tokensRepository.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tokensRepository.query.mock.calls[0];
    expect(sql).toContain('WITH all_ranked_tokens AS');
    expect(sql).toContain('filtered_count AS');
    expect(sql).toContain('RIGHT JOIN filtered_count ON TRUE');
    expect(params).toEqual(['%alpha%', 2, 0]);
    expect(result).toEqual({
      items: [
        { sale_address: 'ct_1', name: 'Alpha' },
        { sale_address: 'ct_2', name: 'Beta' },
      ],
      meta: {
        currentPage: 1,
        itemCount: 2,
        itemsPerPage: 2,
        totalItems: 2,
        totalPages: 1,
      },
    });
  });

  it('orders ranked token pages by treasury using dao balance', async () => {
    const queryBuilder = {
      getQueryAndParameters: jest
        .fn()
        .mockReturnValue([
          'SELECT token.* FROM token WHERE token.unlisted = false',
          [],
        ]),
    } as any;

    tokensRepository.query.mockResolvedValue([]);

    await service.queryTokensWithRanks(queryBuilder, 20, 1, 'treasury', 'DESC');

    const [sql] = tokensRepository.query.mock.calls[0];
    expect(sql).toContain('ORDER BY all_ranked_tokens.dao_balance DESC');
    expect(sql).toContain('ORDER BY paged_tokens.dao_balance DESC');
  });

  it('returns empty items with the correct total when a ranked page is out of range', async () => {
    const queryBuilder = {
      getQueryAndParameters: jest
        .fn()
        .mockReturnValue([
          'SELECT token.* FROM token WHERE token.unlisted = false',
          [],
        ]),
    } as any;

    tokensRepository.query.mockResolvedValue([
      { sale_address: null, total_items: 7 },
    ]);

    const result = await service.queryTokensWithRanks(
      queryBuilder,
      5,
      3,
      'rank',
      'ASC',
    );

    expect(tokensRepository.query).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      items: [],
      meta: {
        currentPage: 3,
        itemCount: 0,
        itemsPerPage: 5,
        totalItems: 7,
        totalPages: 2,
      },
    });
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
    tokenTradeEligibilityCountsRepository.findOne.mockResolvedValue({
      trade_count: 4,
    });

    const breakdown = await service.getTrendingEligibilityBreakdown('ct_sale');

    expect(tokenEligibilityCountsRepository.findOne).toHaveBeenCalledWith({
      where: { symbol: 'TEST' },
    });
    expect(tokenTradeEligibilityCountsRepository.findOne).toHaveBeenCalledWith({
      where: { sale_address: 'ct_sale' },
    });
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

  it('reuses configured contract-not-present retry settings for holder sync retries', async () => {
    (service as any).contractNotPresentMaxAttempts = 2;
    (service as any).contractNotPresentRetryDelayMs = 1234;

    jest
      .spyOn(service, 'getTokenContractsBySaleAddress')
      .mockRejectedValue(new Error('contract_does_not_exist'));
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(
      service._loadHoldersFromContract(
        {
          sale_address: 'ct_missing',
        } as any,
        'ct_aex9',
      ),
    ).rejects.toMatchObject<Partial<RetryableTokenHoldersSyncError>>({
      retryDelayMs: 1234,
    });

    expect(service.getTokenContractsBySaleAddress).toHaveBeenCalledTimes(2);
    expect((service as any).sleep).toHaveBeenCalledWith(1234);
  });

  it('keeps generic holder sync failures at three attempts when contract-not-ready retries are lower', async () => {
    (service as any).contractNotPresentMaxAttempts = 2;

    jest
      .spyOn(service, 'getTokenContractsBySaleAddress')
      .mockRejectedValue(new Error('timeout exceeded'));
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(
      service._loadHoldersFromContract(
        {
          sale_address: 'ct_timeout',
        } as any,
        'ct_aex9',
      ),
    ).resolves.toEqual([]);

    expect(service.getTokenContractsBySaleAddress).toHaveBeenCalledTimes(3);
    expect((service as any).sleep).toHaveBeenNthCalledWith(1, 500);
    expect((service as any).sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  // The holder write opens with a per-token advisory try-lock, so the prune is
  // no longer the first statement on the transaction. Match on the statement
  // rather than its position, so adding another one cannot silently retarget
  // these assertions.
  const holderSyncQuery = (locked = true): jest.Mock =>
    jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('pg_try_advisory_xact_lock') ? [{ locked }] : undefined,
      ),
    );
  const pruneIndexOf = (query: jest.Mock): number =>
    query.mock.calls.findIndex((call: any[]) =>
      String(call[0]).includes('DELETE FROM token_holder'),
    );

  it('syncs holders by upserting then pruning inside one transaction', async () => {
    const upsertRepository = { upsert: jest.fn() };
    const manager = {
      getRepository: jest.fn().mockReturnValue(upsertRepository),
      query: holderSyncQuery(),
    };
    const holdersRepository = {
      manager: { transaction: jest.fn(async (cb: any) => cb(manager)) },
      delete: jest.fn(),
    };
    (service as any).tokenHoldersRepository = holdersRepository;
    jest.spyOn(service, 'getToken').mockResolvedValue({
      address: 'ct_aex9',
      sale_address: 'ct_sale',
    } as any);
    jest.spyOn(service, '_loadHoldersData').mockResolvedValue({
      holders: [{ id: 'h1' }, { id: 'h2' }],
      truncated: false,
    } as any);

    await service.loadAndSaveTokenHoldersFromMdw('ct_sale' as any);

    // The whole holder set must never be deleted and re-inserted: that rewrote
    // every row on every sync and left readers seeing zero holders in between.
    expect(holdersRepository.delete).not.toHaveBeenCalled();
    expect(holdersRepository.manager.transaction).toHaveBeenCalledTimes(1);
    expect(upsertRepository.upsert).toHaveBeenCalledTimes(1);

    const pruneIndex = pruneIndexOf(manager.query);
    const [sql, params] = manager.query.mock.calls[pruneIndex];
    expect(sql).toContain('DELETE FROM token_holder');
    expect(sql).toContain('aex9_address = $1');
    expect(sql).toContain('id <> ALL($2::text[])');
    expect(params).toEqual(['ct_aex9', ['h1', 'h2']]);
    // Upsert first, so the set is never smaller than it should be.
    expect(upsertRepository.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      manager.query.mock.invocationCallOrder[pruneIndex],
    );
    // ...and the lock before either, or neither is protected.
    expect(manager.query.mock.calls[0][0]).toContain(
      'pg_try_advisory_xact_lock',
    );
    expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
      upsertRepository.upsert.mock.invocationCallOrder[0],
    );
  });

  it('writes nothing when another sync holds the per-token advisory lock', async () => {
    const upsertRepository = { upsert: jest.fn() };
    const manager = {
      getRepository: jest.fn().mockReturnValue(upsertRepository),
      query: holderSyncQuery(false),
    };
    const holdersRepository = {
      manager: { transaction: jest.fn(async (cb: any) => cb(manager)) },
      delete: jest.fn(),
    };
    (service as any).tokenHoldersRepository = holdersRepository;
    jest.spyOn(service, 'getToken').mockResolvedValue({
      address: 'ct_aex9',
      sale_address: 'ct_sale',
    } as any);
    jest.spyOn(service, '_loadHoldersData').mockResolvedValue({
      holders: [{ id: 'h1' }],
      truncated: false,
    } as any);

    await service.loadAndSaveTokenHoldersFromMdw('ct_sale' as any);

    // Bailing out is the point: the holder of the lock is mid-write on the
    // same token, and racing it is what deadlocks.
    expect(upsertRepository.upsert).not.toHaveBeenCalled();
    expect(pruneIndexOf(manager.query)).toBe(-1);
    // holders_count must not advance past rows that were never written.
    expect(tokensRepository.update).not.toHaveBeenCalled();
  });

  it('scopes the advisory lock to the token, not the whole table', async () => {
    const upsertRepository = { upsert: jest.fn() };
    const manager = {
      getRepository: jest.fn().mockReturnValue(upsertRepository),
      query: holderSyncQuery(),
    };
    const holdersRepository = {
      manager: { transaction: jest.fn(async (cb: any) => cb(manager)) },
      delete: jest.fn(),
    };
    (service as any).tokenHoldersRepository = holdersRepository;
    jest.spyOn(service, 'getToken').mockResolvedValue({
      address: 'ct_aex9',
      sale_address: 'ct_sale',
    } as any);
    jest.spyOn(service, '_loadHoldersData').mockResolvedValue({
      holders: [{ id: 'h1' }],
      truncated: false,
    } as any);

    await service.loadAndSaveTokenHoldersFromMdw('ct_sale' as any);

    const [lockSql, lockParams] = manager.query.mock.calls[0];
    // A global lock would serialise every token's sync behind one writer.
    expect(lockSql).toContain('hashtext($2)');
    expect(lockParams[1]).toBe('ct_aex9');
    // 2-arg keyspace, so it cannot collide with the single-key advisory locks
    // held elsewhere in the app.
    expect(lockParams[0]).toBe(0x746b686c);
  });

  it('skips the holder swap entirely when the middleware response was truncated', async () => {
    const holdersRepository = {
      manager: { transaction: jest.fn() },
      delete: jest.fn(),
    };
    (service as any).tokenHoldersRepository = holdersRepository;
    jest.spyOn(service, 'getToken').mockResolvedValue({
      address: 'ct_aex9',
      sale_address: 'ct_sale',
    } as any);
    jest.spyOn(service, '_loadHoldersData').mockResolvedValue({
      holders: [{ id: 'h1' }],
      truncated: true,
    } as any);

    await service.loadAndSaveTokenHoldersFromMdw('ct_sale' as any);

    // Pruning on partial data would delete live holders.
    expect(holdersRepository.manager.transaction).not.toHaveBeenCalled();
    expect(tokensRepository.update).not.toHaveBeenCalled();
  });

  it('marks middleware holder loading as truncated when the response is missing data before any holders are loaded', async () => {
    jest.spyOn(service, '_loadHoldersFromContract').mockResolvedValue([]);
    (fetchJson as jest.Mock).mockResolvedValueOnce({ data: null, next: null });

    const result = await service._loadHoldersData(
      { sale_address: 'ct_sale' } as any,
      'ct_aex9',
    );

    expect(result).toEqual({ holders: [], truncated: true });
  });

  it('marks middleware holder loading as truncated when cursor validation fails', async () => {
    jest.spyOn(service, '_loadHoldersFromContract').mockResolvedValue([]);
    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [{ account_id: 'ak_holder', amount: '10' }],
      next: 'https://evil.test/v3/aex9/ct_aex9/balances',
    });

    const result = await service._loadHoldersData(
      { sale_address: 'ct_sale' } as any,
      'ct_aex9',
    );

    expect(result.truncated).toBe(true);
    expect(result.holders).toHaveLength(1);
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

  describe('lookup by name or symbol', () => {
    const lookupQueryBuilder = () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      tokensRepository.createQueryBuilder = jest.fn().mockReturnValue(qb);
      return qb;
    };

    it('folds the input so /tokens/привет resolves like /tokens/ПРИВЕТ', async () => {
      const qb = lookupQueryBuilder();

      await service.findByNameOrSymbol('привет');

      // The column stays bare so the btree index on name/symbol is still used;
      // it is the caller's input that gets folded onto the stored symbol.
      expect(qb.where).toHaveBeenCalledWith('token.name = :name', {
        name: 'ПРИВЕТ',
      });
      expect(qb.orWhere).toHaveBeenCalledWith('token.symbol = :name', {
        name: 'ПРИВЕТ',
      });
    });

    it('leaves caseless symbols untouched', async () => {
      const qb = lookupQueryBuilder();

      await service.findByNameOrSymbol('汉字');

      expect(qb.where).toHaveBeenCalledWith('token.name = :name', {
        name: '汉字',
      });
    });

    it('keeps address matching case-sensitive, since base58 is', async () => {
      const qb = lookupQueryBuilder();

      await service.findByAddress('ct_Sale');

      // Addresses must NOT be folded — base58 is case-significant.
      expect(qb.where).toHaveBeenCalledWith('token.address = :address', {
        address: 'ct_Sale',
      });
      expect(qb.orWhere).toHaveBeenCalledWith('token.sale_address = :address', {
        address: 'ct_Sale',
      });
      // ...while the name/symbol branches of the same query are folded.
      expect(qb.orWhere).toHaveBeenCalledWith('token.name = :symbol', {
        symbol: 'CT_SALE',
      });
    });
  });

  describe('SQL parameterization', () => {
    it('removes duplicated sale addresses in bounded batches', async () => {
      tokensRepository.query.mockResolvedValueOnce([{ ctid: '(0,1)' }]);

      await service.findAndRemoveDuplicatedTokensBaseSaleAddress();

      expect(tokensRepository.delete).toHaveBeenCalledWith({
        sale_address: expect.any(Object),
      });
      expect(tokensRepository.query).toHaveBeenCalledTimes(1);
      const [sql, params] = tokensRepository.query.mock.calls[0];
      expect(params).toEqual([500]);
      expect(sql).toContain('LIMIT $1');
      expect(sql).toContain('RETURNING ctid');
    });

    it('findByAddress passes factory_address and sale_address as $1 and $2', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          sale_address: 'ct_sale',
          factory_address: 'ct_factory',
        }),
      };
      tokensRepository.createQueryBuilder = jest.fn().mockReturnValue(qb);
      tokensRepository.query.mockResolvedValue([
        { rank: 5, performance: { score: 42 } },
      ]);

      await service.findByAddress('ct_sale');

      expect(tokensRepository.query).toHaveBeenCalledTimes(1);
      const [sql, params] = tokensRepository.query.mock.calls[0];
      expect(params).toEqual(['ct_factory', 'ct_sale']);
      expect(sql).toContain('$1');
      expect(sql).toContain('$2');
      expect(sql).not.toContain("'ct_factory'");
      expect(sql).not.toContain("'ct_sale'");
    });

    it('getTokenRanks uses ANY($2::text[]) for the IN-list', async () => {
      communityFactoryService.getCurrentFactory.mockResolvedValue({
        address: 'ct_factory',
      });
      tokensRepository.query.mockResolvedValue([
        { sale_address: 'ct_a', rank: 1 },
        { sale_address: 'ct_b', rank: 2 },
      ]);

      const result = await service.getTokenRanks(['ct_a', 'ct_b']);

      expect(tokensRepository.query).toHaveBeenCalledTimes(1);
      const [sql, params] = tokensRepository.query.mock.calls[0];
      expect(params).toEqual(['ct_factory', ['ct_a', 'ct_b']]);
      expect(sql).toContain('ANY($2::text[])');
      expect(sql).toContain('$1');
      expect(result.get('ct_a')).toBe(1);
      expect(result.get('ct_b')).toBe(2);
    });

    it('getTokenRanksByAex9Address uses ANY($2::text[]) for the IN-list', async () => {
      communityFactoryService.getCurrentFactory.mockResolvedValue({
        address: 'ct_factory',
      });
      tokensRepository.query.mockResolvedValue([{ address: 'ct_x', rank: 3 }]);

      const result = await service.getTokenRanksByAex9Address(['ct_x']);

      const [sql, params] = tokensRepository.query.mock.calls[0];
      expect(params).toEqual(['ct_factory', ['ct_x']]);
      expect(sql).toContain('ANY($2::text[])');
      expect(result.get('ct_x')).toBe(3);
    });
  });

  describe('queueTrendingScoresForSymbols', () => {
    it('enqueues one deduped, delayed job per normalized symbol', async () => {
      await service.queueTrendingScoresForSymbols(['alpha', 'ALPHA', ' beta ']);

      expect(updateTrendingScoresQueue.add).toHaveBeenCalledTimes(2);
      expect(updateTrendingScoresQueue.add).toHaveBeenCalledWith(
        { symbol: 'ALPHA' },
        expect.objectContaining({
          jobId: 'updateTrendingScores-ALPHA',
          delay: 5_000,
          removeOnComplete: true,
          removeOnFail: true,
        }),
      );
      expect(updateTrendingScoresQueue.add).toHaveBeenCalledWith(
        { symbol: 'BETA' },
        expect.objectContaining({ jobId: 'updateTrendingScores-BETA' }),
      );
    });

    it('does not enqueue anything for blank symbols', async () => {
      await service.queueTrendingScoresForSymbols(['', '   ']);

      expect(updateTrendingScoresQueue.add).not.toHaveBeenCalled();
    });

    it('configures retries so a transient failure does not permanently drop the recompute', async () => {
      await service.queueTrendingScoresForSymbols(['alpha']);

      expect(updateTrendingScoresQueue.add).toHaveBeenCalledWith(
        { symbol: 'ALPHA' },
        expect.objectContaining({
          attempts: 3,
          backoff: expect.objectContaining({ type: 'exponential' }),
        }),
      );
    });
  });
});

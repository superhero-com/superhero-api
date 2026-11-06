import { DexSyncService } from './dex-sync.service';

describe('DexSyncService', () => {
  const setup = () => {
    const dexTokenRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      find: jest.fn(),
    } as any;
    const pairQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };
    const dexPairRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(pairQueryBuilder),
      find: jest.fn().mockResolvedValue([]),
    } as any;
    const pairService = {
      getFactoryPairAddresses: jest.fn().mockResolvedValue(new Set()),
      syncPairFromChain: jest.fn().mockResolvedValue(undefined),
    } as any;
    const dexTokenService = {
      getAllPairsWithTokens: jest.fn(),
      getTokenPriceWithLiquidityAnalysis: jest.fn(),
    } as any;
    const pairSummaryService = {
      createOrUpdateSummary: jest.fn(),
    } as any;
    const tokenSummaryService = {
      createOrUpdateSummary: jest.fn(),
    } as any;
    const aePricingService = {
      getPriceData: jest.fn(),
    } as any;
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as any;

    const service = new DexSyncService(
      dexTokenRepository,
      dexPairRepository,
      dataSource,
      pairService,
      dexTokenService,
      pairSummaryService,
      aePricingService,
      tokenSummaryService,
    );

    return {
      service,
      dexTokenRepository,
      dexPairRepository,
      pairService,
      dexTokenService,
      pairQueryBuilder,
      pairSummaryService,
      tokenSummaryService,
      aePricingService,
      dataSource,
      queryRunner,
    };
  };

  describe('refreshing pairs from chain', () => {
    const pricing = (ctx: ReturnType<typeof setup>) => {
      ctx.dexTokenRepository.find
        .mockResolvedValueOnce([{ address: 'ct_token' }])
        .mockResolvedValueOnce([]);
      ctx.dexTokenService.getAllPairsWithTokens.mockResolvedValue([]);
      ctx.dexTokenService.getTokenPriceWithLiquidityAnalysis.mockResolvedValue(
        null,
      );
      ctx.pairQueryBuilder.getMany.mockResolvedValue([]);
    };

    it('refreshes factory pairs before pricing and skips pairs the factory does not know', async () => {
      const ctx = setup();
      pricing(ctx);
      const known = { address: 'ct_known' };
      const unknown = { address: 'ct_unknown' };
      ctx.dexPairRepository.find.mockResolvedValue([known, unknown]);
      ctx.pairService.getFactoryPairAddresses.mockResolvedValue(
        new Set(['ct_known']),
      );

      await ctx.service.syncTokenPrices();

      expect(ctx.pairService.syncPairFromChain).toHaveBeenCalledTimes(1);
      expect(ctx.pairService.syncPairFromChain).toHaveBeenCalledWith(known);
      expect(
        ctx.pairService.syncPairFromChain.mock.invocationCallOrder[0],
      ).toBeLessThan(
        ctx.dexTokenService.getAllPairsWithTokens.mock.invocationCallOrder[0],
      );
      expect(ctx.dexTokenService.getAllPairsWithTokens).toHaveBeenCalledWith({
        fresh: true,
      });
    });

    it('keeps refreshing and pricing when one pair fails', async () => {
      const ctx = setup();
      pricing(ctx);
      ctx.dexPairRepository.find.mockResolvedValue([
        { address: 'ct_a' },
        { address: 'ct_b' },
      ]);
      ctx.pairService.getFactoryPairAddresses.mockResolvedValue(
        new Set(['ct_a', 'ct_b']),
      );
      ctx.pairService.syncPairFromChain.mockRejectedValueOnce(
        new Error('socket hang up'),
      );

      await ctx.service.syncTokenPrices();

      expect(ctx.pairService.syncPairFromChain).toHaveBeenCalledTimes(2);
      expect(
        ctx.dexTokenService.getTokenPriceWithLiquidityAnalysis,
      ).toHaveBeenCalledTimes(1);
    });

    it('prices from stored reserves when the factory cannot be read', async () => {
      const ctx = setup();
      pricing(ctx);
      ctx.pairService.getFactoryPairAddresses.mockRejectedValue(
        new Error('socket hang up'),
      );

      await ctx.service.syncTokenPrices();

      expect(ctx.pairService.syncPairFromChain).not.toHaveBeenCalled();
      expect(
        ctx.dexTokenService.getTokenPriceWithLiquidityAnalysis,
      ).toHaveBeenCalledTimes(1);
    });
  });

  it('reuses one pair snapshot and shared price cache during syncTokenPrices', async () => {
    const {
      service,
      dexTokenRepository,
      dexTokenService,
      pairQueryBuilder,
      tokenSummaryService,
      aePricingService,
    } = setup();
    const allPairs = [{ address: 'ct_pair_a' }] as any;
    const tokens = [{ address: 'ct_token_a' }, { address: 'ct_token_b' }];

    dexTokenRepository.find
      .mockResolvedValueOnce(tokens)
      .mockResolvedValueOnce([]);
    dexTokenService.getAllPairsWithTokens.mockResolvedValue(allPairs);
    dexTokenService.getTokenPriceWithLiquidityAnalysis.mockResolvedValue({
      // syncTokenPrices stores the deepest-path `price`, not the median.
      price: '1.5',
    });
    aePricingService.getPriceData.mockResolvedValue({ ae: '1.5' });
    tokenSummaryService.createOrUpdateSummary.mockResolvedValue(undefined);
    pairQueryBuilder.getMany.mockResolvedValue([]);

    await service.syncTokenPrices();

    expect(dexTokenService.getAllPairsWithTokens).toHaveBeenCalledTimes(1);
    expect(
      dexTokenService.getTokenPriceWithLiquidityAnalysis,
    ).toHaveBeenNthCalledWith(1, 'ct_token_a', expect.any(String), {
      allPairs,
    });
    expect(
      dexTokenService.getTokenPriceWithLiquidityAnalysis,
    ).toHaveBeenNthCalledWith(2, 'ct_token_b', expect.any(String), {
      allPairs,
    });

    const [firstToken, firstOptions] =
      tokenSummaryService.createOrUpdateSummary.mock.calls[0];
    const [secondToken, secondOptions] =
      tokenSummaryService.createOrUpdateSummary.mock.calls[1];

    expect(firstToken).toBe('ct_token_a');
    expect(secondToken).toBe('ct_token_b');
    expect(firstOptions.allPairs).toBe(allPairs);
    expect(secondOptions.allPairs).toBe(allPairs);
    expect(firstOptions.priceCache).toBe(secondOptions.priceCache);
    expect(firstOptions.priceCache).toBeInstanceOf(Map);
  });

  describe('scheduledPriceSync (cron)', () => {
    const ORIGINAL = process.env.DISABLE_MDW_SYNC;
    const unlockCalls = (qr: any) =>
      qr.query.mock.calls.filter((c: any[]) =>
        String(c[0]).includes('pg_advisory_unlock'),
      );
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.DISABLE_MDW_SYNC;
      else process.env.DISABLE_MDW_SYNC = ORIGINAL;
    });

    it('skips entirely when live sync is disabled', async () => {
      process.env.DISABLE_MDW_SYNC = 'true';
      const { service, dataSource } = setup();
      const sync = jest
        .spyOn(service, 'syncTokenPrices')
        .mockResolvedValue(undefined);

      await service.scheduledPriceSync();

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    });

    it('skips the sync (no unlock) but releases the runner when another instance holds the lock', async () => {
      delete process.env.DISABLE_MDW_SYNC;
      const { service, queryRunner } = setup();
      queryRunner.query.mockResolvedValue([{ locked: false }]);
      const sync = jest
        .spyOn(service, 'syncTokenPrices')
        .mockResolvedValue(undefined);

      await service.scheduledPriceSync();

      expect(sync).not.toHaveBeenCalled();
      expect(unlockCalls(queryRunner)).toHaveLength(0);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('runs the sync under the advisory lock and releases it', async () => {
      delete process.env.DISABLE_MDW_SYNC;
      const { service, queryRunner } = setup();
      queryRunner.query.mockImplementation((sql: string) =>
        String(sql).includes('pg_try_advisory_lock')
          ? Promise.resolve([{ locked: true }])
          : Promise.resolve([]),
      );
      const sync = jest
        .spyOn(service, 'syncTokenPrices')
        .mockResolvedValue(undefined);

      await service.scheduledPriceSync();

      expect(sync).toHaveBeenCalledTimes(1);
      expect(unlockCalls(queryRunner)).toHaveLength(1);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('releases the lock and swallows the error if the sync throws', async () => {
      delete process.env.DISABLE_MDW_SYNC;
      const { service, queryRunner } = setup();
      queryRunner.query.mockImplementation((sql: string) =>
        String(sql).includes('pg_try_advisory_lock')
          ? Promise.resolve([{ locked: true }])
          : Promise.resolve([]),
      );
      jest
        .spyOn(service, 'syncTokenPrices')
        .mockRejectedValue(new Error('boom'));

      await expect(service.scheduledPriceSync()).resolves.toBeUndefined();

      expect(unlockCalls(queryRunner)).toHaveLength(1);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });
  });
});

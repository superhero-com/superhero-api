import { TX_FUNCTIONS } from '@/configs';
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
      find: jest.fn(),
    } as any;
    const dexPairTransactionRepository = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
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
      dexPairTransactionRepository,
      dataSource,
      { sdk: {} } as any,
      { findByAddress: jest.fn(), pullPairData: jest.fn() } as any,
      dexTokenService,
      pairSummaryService,
      {} as any,
      aePricingService,
      tokenSummaryService,
    );

    return {
      service,
      dexTokenRepository,
      dexPairRepository,
      dexPairTransactionRepository,
      dexTokenService,
      pairQueryBuilder,
      pairSummaryService,
      tokenSummaryService,
      aePricingService,
      dataSource,
      queryRunner,
    };
  };

  it('falls back to factory decode when router decode returns empty array', async () => {
    const { service } = setup();
    const routerDecode = jest.fn().mockReturnValue([]);
    const factoryDecode = jest
      .fn()
      .mockReturnValue([
        { contract: { name: 'IAedexV2Pair', address: 'ct_pair' } },
      ]);
    (service as any).routerContract = { $decodeEvents: routerDecode };
    (service as any).factoryContract = { $decodeEvents: factoryDecode };
    jest
      .spyOn(service as any, 'getOrCreateToken')
      .mockResolvedValueOnce({ address: 'ct_t0' })
      .mockResolvedValueOnce({ address: 'ct_t1' });

    const result = await (service as any).extractPairInfoFromTransaction({
      tx: {
        function: TX_FUNCTIONS.add_liquidity,
        arguments: [{ value: 'ct_t0' }, { value: 'ct_t1' }],
        log: [],
      },
    });

    expect(routerDecode).toHaveBeenCalledTimes(1);
    expect(factoryDecode).toHaveBeenCalledTimes(1);
    expect(result?.pairAddress).toBe('ct_pair');
  });

  it('loads pair relation after upsert when fetching saved tx', async () => {
    const { service, dexPairTransactionRepository } = setup();
    dexPairTransactionRepository.findOne.mockResolvedValue({
      tx_hash: 'th_1',
      pair: { address: 'ct_pair' },
    });

    await (service as any).saveDexPairTransaction(
      { address: 'ct_pair' },
      {
        hash: 'th_1',
        blockHeight: 1,
        microTime: 1000,
        tx: { callerId: 'ak_1', function: 'swap' },
      },
      {
        reserve0: 1,
        reserve1: 1,
        volume0: 0,
        volume1: 0,
        swapInfo: null,
        pairMintInfo: null,
      },
    );

    expect(dexPairTransactionRepository.findOne).toHaveBeenCalledWith({
      where: { tx_hash: 'th_1' },
      relations: { pair: true },
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

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

    const service = new DexSyncService(
      dexTokenRepository,
      dexPairRepository,
      dexPairTransactionRepository,
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
      medianPrice: '1.5',
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
});

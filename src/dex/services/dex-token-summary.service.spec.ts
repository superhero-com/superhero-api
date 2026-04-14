import { DexTokenSummaryService } from './dex-token-summary.service';

describe('DexTokenSummaryService', () => {
  const makePair = (
    address: string,
    token0Address: string,
    token1Address: string,
  ) =>
    ({
      address,
      token0: { address: token0Address, decimals: 18 },
      token1: { address: token1Address, decimals: 18 },
    }) as any;

  const setup = () => {
    const dexTokenSummaryRepository = {
      findOne: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn((value) => Promise.resolve(value)),
    } as any;
    const dexTokenRepository = {
      findOne: jest.fn(),
    } as any;
    const pairQueryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };
    const pairRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(pairQueryBuilder),
    } as any;
    const query = jest.fn((sql: string) => {
      if (sql.includes('start_ratio')) {
        return Promise.resolve([{ start_ratio: '1', current_ratio: '2' }]);
      }
      return Promise.resolve([{ total_volume: '1' }]);
    });
    const release = jest.fn().mockResolvedValue(undefined);
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue({
        query,
        release,
      }),
    } as any;
    const aePricingService = {
      getPriceData: jest.fn().mockResolvedValue({ ae: '1' }),
    } as any;
    const dexTokenService = {
      getTokenPriceWithLiquidityAnalysis: jest.fn().mockResolvedValue({
        medianPrice: '2',
      }),
    } as any;

    const service = new DexTokenSummaryService(
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dataSource,
      aePricingService,
      dexTokenService,
    );

    return {
      service,
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dexTokenService,
      query,
      release,
    };
  };

  it('reuses supplied price cache and allPairs during summary generation', async () => {
    const {
      service,
      dexTokenSummaryRepository,
      dexTokenRepository,
      pairRepository,
      dexTokenService,
    } = setup();
    const tokenAddress = 'ct_token';
    const allPairs = [
      makePair('ct_pair_1', tokenAddress, 'ct_other_1'),
      makePair('ct_pair_2', tokenAddress, 'ct_other_2'),
    ];
    const priceCache = new Map<string, Promise<string | null>>();

    dexTokenRepository.findOne.mockResolvedValue({ address: tokenAddress });
    dexTokenSummaryRepository.findOne.mockResolvedValue(null);

    await service.createOrUpdateSummary(tokenAddress, { allPairs, priceCache });
    await service.createOrUpdateSummary(tokenAddress, { allPairs, priceCache });

    expect(pairRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(
      dexTokenService.getTokenPriceWithLiquidityAnalysis,
    ).toHaveBeenCalledTimes(1);
    expect(
      dexTokenService.getTokenPriceWithLiquidityAnalysis,
    ).toHaveBeenCalledWith(tokenAddress, expect.any(String), { allPairs });
    expect(priceCache.has(tokenAddress)).toBe(true);
  });
});

import { AETERNITY_COIN_ID, CURRENCIES } from '@/configs';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { fetchJson } from '@/utils/common';
import { CurrencyRates } from '@/utils/types';
import { Test, TestingModule } from '@nestjs/testing';
import BigNumber from 'bignumber.js';
import moment from 'moment';
import type { Cache } from 'cache-manager';
import { CoinGeckoService } from './coin-gecko.service';

jest.mock('@/utils/common', () => ({
  fetchJson: jest.fn(),
}));

const buildCompleteRates = (
  overrides: Partial<CurrencyRates> = {},
): CurrencyRates =>
  ({
    ...Object.fromEntries(
      CURRENCIES.map(({ code }, index) => [code, (index + 1) / 100]),
    ),
    ...overrides,
  }) as CurrencyRates;

describe('CoinGeckoService', () => {
  let service: CoinGeckoService;
  let cacheManager: Pick<Cache, 'get' | 'set'>;

  beforeEach(async () => {
    jest.useFakeTimers();
    cacheManager = {
      get: jest.fn(),
      set: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoinGeckoService,
        {
          provide: CACHE_MANAGER,
          useValue: cacheManager,
        },
      ],
    }).compile();

    service = module.get<CoinGeckoService>(CoinGeckoService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should not pull data on instantiation (syncAllFromApi drives all fetches)', () => {
    (fetchJson as jest.Mock).mockResolvedValue(null);
    new CoinGeckoService(cacheManager as any);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('should fetch coin currency rates correctly', async () => {
    const mockRates = buildCompleteRates({ usd: 0.1, eur: 0.09 });
    (fetchJson as jest.Mock).mockResolvedValue({
      [AETERNITY_COIN_ID]: mockRates,
    });

    const rates = await (service as any).fetchCoinCurrencyRates(
      AETERNITY_COIN_ID,
    );
    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('/simple/price'),
    );
    expect(rates).toEqual(mockRates);
  });

  it('should reject incomplete coin currency rates', async () => {
    (fetchJson as jest.Mock).mockResolvedValue({
      [AETERNITY_COIN_ID]: { usd: 0.1 },
    });

    const rates = await (service as any).fetchCoinCurrencyRates(
      AETERNITY_COIN_ID,
    );

    expect(rates).toBeNull();
  });

  it('should return null when fetching coin currency rates fails', async () => {
    (fetchJson as jest.Mock).mockRejectedValue(new Error('API Error'));
    const rates = await (service as any).fetchCoinCurrencyRates(
      AETERNITY_COIN_ID,
    );
    expect(rates).toBeNull();
  });

  it('should check if pull time is expired', () => {
    service.last_pull_time = moment().subtract(3, 'minutes');
    expect(service.isPullTimeExpired()).toBeTruthy();
  });

  it('should not expire pull time within 2 minutes', () => {
    service.last_pull_time = moment().subtract(1, 'minute');
    expect(service.isPullTimeExpired()).toBeFalsy();
  });

  it('should get price data correctly', async () => {
    service.rates = { usd: 0.1, eur: 0.09 } as any;
    const price = new BigNumber(100);
    const result = await service.getPriceData(price);

    expect(result.ae).toEqual(price);
    expect(result.usd).toEqual(price.multipliedBy(0.1));
    expect(result.eur).toEqual(price.multipliedBy(0.09));
  });

  it('should return null for unsupported currencies in getPriceData', async () => {
    service.rates = { usd: 0.1 } as any;
    const price = new BigNumber(100);
    const result = await service.getPriceData(price);

    expect(result.ae).toEqual(price);
    expect(result.usd).toEqual(price.multipliedBy(0.1));
    expect(result.eur).toBeNull(); // Ensure unsupported currencies return null
  });

  it('should return cached rates only when all supported currencies are present', async () => {
    const cachedRates = buildCompleteRates({ usd: 0.1 });
    (cacheManager.get as jest.Mock).mockResolvedValue(cachedRates);

    await expect(service.getAeternityRates()).resolves.toEqual(cachedRates);
  });

  it('should not return incomplete cached rates', async () => {
    (cacheManager.get as jest.Mock).mockResolvedValue({ usd: 0.1 });

    await expect(service.getAeternityRates()).rejects.toThrow(
      'Aeternity rates are temporarily unavailable',
    );
  });

  it('should fetch data from API correctly', async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ data: 'mockData' });

    const result = await (service as any).fetchFromApi('/market', {
      ids: 'ae',
    });
    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('/market?ids=ae'),
    );
    expect(result).toEqual({ data: 'mockData' });
  });

  it('should reuse cached market data for three minutes by default', async () => {
    const cachedMarket = {
      data: {
        id: AETERNITY_COIN_ID,
        currentPrice: 0.1,
      },
      fetchedAt: Date.now() - 2 * 60 * 1000,
    };
    (cacheManager.get as jest.Mock).mockResolvedValue(cachedMarket);

    const result = await service.getCoinMarketData(AETERNITY_COIN_ID, 'usd');

    expect(result).toEqual(cachedMarket.data);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('should return fallback market data when market cache is empty', async () => {
    (cacheManager.get as jest.Mock).mockResolvedValue(null);
    jest.spyOn(service as any, 'readFallbackPricingData').mockReturnValue({
      prices: [
        [1000, 0.1],
        [2000, 0.12],
      ],
      market_caps: [
        [1000, 100],
        [2000, 120],
      ],
      total_volumes: [
        [1000, 10],
        [2000, 12],
      ],
    });

    const result = await service.getCoinMarketData(AETERNITY_COIN_ID, 'usd');

    expect(result).toMatchObject({
      id: AETERNITY_COIN_ID,
      currentPrice: 0.12,
      marketCap: 120,
      totalVolume: 12,
      marketCapChange24h: 20,
      dataSource: 'fallback',
      isFallback: true,
    });
    expect(result.priceChange24h).toBeCloseTo(0.02);
    expect(cacheManager.set).toHaveBeenCalledWith(
      `coingecko:market:v1:${AETERNITY_COIN_ID}:usd`,
      expect.objectContaining({
        data: expect.objectContaining({
          currentPrice: 0.12,
          dataSource: 'fallback',
          isFallback: true,
        }),
        fetchedAt: expect.any(Number),
      }),
      60 * 60 * 1000,
    );
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

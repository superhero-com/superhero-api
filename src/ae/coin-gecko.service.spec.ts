import { AETERNITY_COIN_ID } from '@/configs';
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

  it('should initialize and pull data on instantiation', async () => {
    const pullDataSpy = jest
      .spyOn(CoinGeckoService.prototype, 'pullData')
      .mockResolvedValue(undefined as any);

    new CoinGeckoService(cacheManager as any);

    expect(pullDataSpy).toHaveBeenCalled();
  });

  it('should fetch coin currency rates correctly', async () => {
    const mockRates: CurrencyRates = { usd: 0.1, eur: 0.09 } as any;
    (fetchJson as jest.Mock).mockResolvedValue({
      [AETERNITY_COIN_ID]: mockRates,
    });

    const rates = await service.fetchCoinCurrencyRates(AETERNITY_COIN_ID);
    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('/simple/price'),
    );
    expect(rates).toEqual(mockRates);
  });

  it('should return null when fetching coin currency rates fails', async () => {
    (fetchJson as jest.Mock).mockRejectedValue(new Error('API Error'));
    const rates = await service.fetchCoinCurrencyRates(AETERNITY_COIN_ID);
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

  it('should fetch data from API correctly', async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ data: 'mockData' });

    const result = await service.fetchFromApi('/market', { ids: 'ae' });
    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining('/market?ids=ae'),
    );
    expect(result).toEqual({ data: 'mockData' });
  });
});

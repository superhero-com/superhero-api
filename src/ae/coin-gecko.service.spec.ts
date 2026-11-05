import { AETERNITY_COIN_ID, CURRENCIES } from '@/configs';
import { CoinHistoricalPriceService } from '@/ae-pricing/services/coin-historical-price.service';
import { fetchJson } from '@/utils/common';
import { CurrencyRates } from '@/utils/types';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import moment from 'moment';
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

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MARKET_KEY = `coingecko:market:v1:${AETERNITY_COIN_ID}:usd`;
const RATES_KEY = 'coingecko:rates';
const FALLBACK_PRICES: Array<[number, number]> = [[1, 0.5]];

const daysAgo = (days: number) => moment(NOW).subtract(days, 'days').valueOf();

const historicalKey = (days: number, interval = 'none') =>
  `coingecko:historical:${AETERNITY_COIN_ID}:usd:${days}:${interval}`;

/**
 * A fresh service with a fixed clock, a mocked Redis and (optionally) a
 * mocked price-history store whose merge is the real implementation.
 */
const build = ({ withHistory = true } = {}) => {
  const cache = {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const history = {
    getHistoricalPriceData: jest.fn().mockResolvedValue([]),
    getLatestTimestamp: jest.fn().mockResolvedValue(null),
    getMissingDataRanges: jest.fn().mockResolvedValue([]),
    savePriceData: jest.fn().mockResolvedValue(undefined),
    mergePriceData: jest.fn((existing, fresh) =>
      CoinHistoricalPriceService.prototype.mergePriceData(existing, fresh),
    ),
  };
  const service = new CoinGeckoService(
    cache as any,
    withHistory ? (history as any) : undefined,
  );
  const useFallbackJson = () =>
    jest
      .spyOn(service as any, 'readFallbackPricingData')
      .mockReturnValue({ prices: FALLBACK_PRICES });
  return { service, cache, history, useFallbackJson };
};

const fetchMock = fetchJson as jest.Mock;
const chartCalls = () =>
  fetchMock.mock.calls
    .map(([url]) => new URL(url))
    .filter((url) => url.pathname.endsWith('/market_chart'));

describe('CoinGeckoService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    fetchMock.mockReset();
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('syncAllFromApi', () => {
    const rates = buildCompleteRates({ usd: 0.02 });

    const routeApi = ({
      simplePrice = async () => ({ [AETERNITY_COIN_ID]: rates }),
      markets = async () => [
        { id: AETERNITY_COIN_ID, current_price: 0.02, market_cap: 9 },
      ],
      chart = async () => ({ prices: [[NOW - HOUR, 0.02]] }),
    }: Partial<Record<'simplePrice' | 'markets' | 'chart', () => any>> = {}) =>
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('/simple/price')) return simplePrice();
        if (url.includes('/coins/markets')) return markets();
        if (url.includes('/market_chart')) return chart();
        throw new Error(`unexpected url ${url}`);
      });

    it('makes no API call when the service is constructed', () => {
      build();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stores rates in memory and Redis, caches camel-cased market data, and refreshes all three price series', async () => {
      const { service, cache, history } = build();
      history.getMissingDataRanges.mockResolvedValue([[daysAgo(365), NOW]]);
      routeApi();

      await service.syncAllFromApi();

      expect(service.rates).toEqual(rates);
      expect(service.last_pull_time.valueOf()).toBe(NOW);
      expect(cache.set).toHaveBeenCalledWith(RATES_KEY, rates, 10 * 60 * 1000);
      expect(cache.set).toHaveBeenCalledWith(
        MARKET_KEY,
        {
          data: { id: AETERNITY_COIN_ID, currentPrice: 0.02, marketCap: 9 },
          fetchedAt: NOW,
        },
        DAY,
      );
      expect(
        chartCalls().map((url) => [
          url.searchParams.get('days'),
          url.searchParams.get('interval'),
        ]),
      ).toEqual([
        ['365', 'daily'],
        ['7', 'daily'],
        ['1', 'hourly'],
      ]);
    });

    it('still syncs market data and price history when the rates request fails', async () => {
      const { service, cache, history } = build();
      history.getMissingDataRanges.mockResolvedValue([[daysAgo(365), NOW]]);
      routeApi({
        simplePrice: async () => {
          throw new Error('coingecko down');
        },
      });

      await service.syncAllFromApi();

      expect(service.rates).toBeNull();
      expect(cache.set).not.toHaveBeenCalledWith(
        RATES_KEY,
        expect.anything(),
        expect.anything(),
      );
      expect(cache.set).toHaveBeenCalledWith(
        MARKET_KEY,
        expect.anything(),
        DAY,
      );
      expect(chartCalls()).toHaveLength(3);
    });

    it.each([
      ['an error object', async () => ({ status: { error_code: 429 } })],
      ['an empty list', async () => []],
      [
        'a network error',
        async () => {
          throw new Error('coingecko down');
        },
      ],
    ])(
      'does not overwrite cached market data when CoinGecko returns %s',
      async (_label, markets) => {
        const { service, cache } = build();
        routeApi({ markets });

        await service.syncAllFromApi();

        expect(cache.set).not.toHaveBeenCalledWith(
          MARKET_KEY,
          expect.anything(),
          expect.anything(),
        );
        expect(chartCalls().length).toBeGreaterThan(0);
      },
    );

    it('still refreshes price history when caching market data fails', async () => {
      const { service, cache } = build();
      routeApi();
      cache.set.mockImplementation(async (key: string) => {
        if (key === MARKET_KEY) throw new Error('redis down');
      });
      const refresh = jest
        .spyOn(service as any, 'refreshHistoricalPrice')
        .mockResolvedValue([]);

      await expect(service.syncAllFromApi()).resolves.toBeUndefined();

      expect(refresh).toHaveBeenCalledTimes(3);
    });

    it.each([0, 1, 2])(
      'keeps refreshing the other price series when refresh #%i throws',
      async (failing) => {
        const { service } = build();
        routeApi();
        const refresh = jest
          .spyOn(service as any, 'refreshHistoricalPrice')
          .mockImplementation(async () => {
            if (refresh.mock.calls.length - 1 === failing) {
              throw new Error('boom');
            }
            return [];
          });

        await expect(service.syncAllFromApi()).resolves.toBeUndefined();

        expect(refresh.mock.calls).toEqual([
          [AETERNITY_COIN_ID, 'usd', 365, 'daily'],
          [AETERNITY_COIN_ID, 'usd', 7, 'daily'],
          [AETERNITY_COIN_ID, 'usd', 1, 'hourly'],
        ]);
      },
    );
  });

  describe('pullData', () => {
    const fresh = buildCompleteRates({ usd: 0.03 });
    const cached = buildCompleteRates({ usd: 0.025 });
    const previous = buildCompleteRates({ usd: 0.02 });
    const pull = (service: CoinGeckoService) => (service as any).pullData();

    it('keeps fresh rates in memory even when writing them to Redis fails', async () => {
      const { service, cache } = build();
      fetchMock.mockResolvedValue({ [AETERNITY_COIN_ID]: fresh });
      cache.set.mockRejectedValue(new Error('redis down'));

      await pull(service);

      expect(service.rates).toEqual(fresh);
      expect(service.last_pull_time.valueOf()).toBe(NOW);
    });

    it.each([
      ['fails', () => fetchMock.mockRejectedValue(new Error('down'))],
      ['returns null', () => fetchMock.mockResolvedValue(null)],
      [
        'omits the coin',
        () => fetchMock.mockResolvedValue({ bitcoin: { usd: 1 } }),
      ],
      [
        'returns incomplete rates',
        () => fetchMock.mockResolvedValue({ [AETERNITY_COIN_ID]: { usd: 1 } }),
      ],
    ])('adopts the Redis rates when the API %s', async (_label, arrange) => {
      const { service, cache } = build();
      arrange();
      cache.get.mockResolvedValue(cached);

      await pull(service);

      expect(service.rates).toEqual(cached);
      expect(service.last_pull_time.valueOf()).toBe(NOW);
      expect(cache.set).not.toHaveBeenCalled();
    });

    it.each([
      ['has nothing', async () => undefined],
      ['has incomplete rates', async () => ({ usd: 1 })],
      [
        'cannot be read',
        async () => {
          throw new Error('redis down');
        },
      ],
    ])(
      'keeps the previous rates without renewing their age when the API fails and Redis %s',
      async (_label, redisGet) => {
        const { service, cache } = build();
        const pulledAt = moment(NOW - 5 * 60 * 1000);
        service.rates = previous;
        service.last_pull_time = pulledAt;
        fetchMock.mockRejectedValue(new Error('down'));
        cache.get.mockImplementation(redisGet);

        await pull(service);

        expect(service.rates).toBe(previous);
        // A renewed pull time would let getAeternityRates serve these rates as
        // fresh for another two minutes.
        expect(service.last_pull_time).toBe(pulledAt);
      },
    );

    it('stays empty when neither the API nor Redis has rates', async () => {
      const { service } = build();
      fetchMock.mockRejectedValue(new Error('down'));

      await pull(service);

      expect(service.rates).toBeNull();
    });
  });

  describe('getAeternityRates', () => {
    const memory = buildCompleteRates({ usd: 0.02 });
    const redis = buildCompleteRates({ usd: 0.021 });

    it('serves in-memory rates pulled within the last two minutes without reading Redis', async () => {
      const { service, cache } = build();
      service.rates = memory;
      service.last_pull_time = moment(NOW - 60 * 1000);

      await expect(service.getAeternityRates()).resolves.toBe(memory);
      expect(cache.get).not.toHaveBeenCalled();
    });

    it.each([
      ['older than two minutes', memory, NOW - 3 * 60 * 1000],
      ['incomplete', { usd: 0.02 }, NOW],
    ])(
      'reloads from Redis when the in-memory rates are %s',
      async (_label, rates, pulledAt) => {
        const { service, cache } = build();
        service.rates = rates as CurrencyRates;
        service.last_pull_time = moment(pulledAt);
        cache.get.mockResolvedValue(redis);

        await expect(service.getAeternityRates()).resolves.toBe(redis);
        expect(cache.get).toHaveBeenCalledWith(RATES_KEY);
        expect(service.rates).toBe(redis);
        expect(service.last_pull_time.valueOf()).toBe(NOW);
      },
    );

    it.each([
      ['Redis is empty', async () => undefined],
      ['Redis has incomplete rates', async () => ({ usd: 0.021 })],
      [
        'Redis cannot be read',
        async () => {
          throw new Error('redis down');
        },
      ],
    ])(
      'throws 503 rather than serving expired rates or calling the API when %s',
      async (_label, redisGet) => {
        const { service, cache } = build();
        service.rates = memory;
        service.last_pull_time = moment(NOW - 3 * 60 * 1000);
        cache.get.mockImplementation(redisGet);

        await expect(service.getAeternityRates()).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('getPriceData', () => {
    const nulls = Object.fromEntries(
      CURRENCIES.map(({ code }) => [code, null]),
    );

    it('warms empty memory from Redis and converts every currency', async () => {
      const { service, cache } = build();
      const rates = buildCompleteRates();
      cache.get.mockResolvedValue(rates);

      const result = await service.getPriceData(new BigNumber(10));

      expect(service.rates).toBe(rates);
      for (const { code } of CURRENCIES) {
        expect(result[code]).toEqual(
          new BigNumber(10).multipliedBy(rates[code]),
        );
      }
    });

    it.each([
      ['empty', async () => undefined],
      ['incomplete', async () => ({ usd: 0.02 })],
      [
        'unreadable',
        async () => {
          throw new Error('redis down');
        },
      ],
    ])(
      'returns only the AE amount, without calling the API, when memory is empty and Redis is %s',
      async (_label, redisGet) => {
        const { service, cache } = build();
        cache.get.mockImplementation(redisGet);
        const price = new BigNumber(10);

        await expect(service.getPriceData(price)).resolves.toEqual({
          ae: price,
          ...nulls,
        });
        expect(service.rates).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('uses rates already in memory, however old, without reading Redis', async () => {
      const { service, cache } = build();
      service.rates = buildCompleteRates({ usd: 0.5 });
      service.last_pull_time = moment(NOW - DAY);

      const result = await service.getPriceData(new BigNumber(2));

      expect(result.usd).toEqual(new BigNumber(1));
      expect(cache.get).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', undefined],
      ['not a number', '0.4'],
    ])('nulls only the currency whose rate is %s', async (_label, eur) => {
      const { service } = build();
      service.rates = buildCompleteRates({ usd: 0.5, eur: eur as any });

      const result = await service.getPriceData(new BigNumber(2));

      expect(result.usd).toEqual(new BigNumber(1));
      expect(result.eur).toBeNull();
    });
  });

  describe('getCoinMarketData', () => {
    const market = { id: AETERNITY_COIN_ID, currentPrice: 0.02 };
    const fallbackAt = (prices: Array<[number, number]>) => ({ prices });

    it('serves cached market data older than the max age until the next sync', async () => {
      const { service, cache } = build();
      cache.get.mockResolvedValue({ data: market, fetchedAt: NOW - HOUR });

      await expect(
        service.getCoinMarketData(AETERNITY_COIN_ID, 'usd'),
      ).resolves.toBe(market);
      expect(cache.set).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('derives market data from the bundled JSON on an empty cache and caches it for an hour', async () => {
      const { service, cache } = build();
      jest.spyOn(service as any, 'readFallbackPricingData').mockReturnValue({
        prices: [
          [NOW - DAY, 0.1],
          [NOW, 0.12],
        ],
        market_caps: [
          [NOW - DAY, 100],
          [NOW, 120],
        ],
        total_volumes: [
          [NOW - DAY, 10],
          [NOW, 12],
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
      expect(cache.set).toHaveBeenCalledWith(
        MARKET_KEY,
        { data: result, fetchedAt: NOW },
        HOUR,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['has no fetchedAt', async () => ({ data: market })],
      [
        'has a non-finite fetchedAt',
        async () => ({ data: market, fetchedAt: NaN }),
      ],
      ['has no data', async () => ({ fetchedAt: NOW })],
      [
        'cannot be read',
        async () => {
          throw new Error('redis down');
        },
      ],
    ])(
      'falls back to the bundled JSON when the cache entry %s',
      async (_label, redisGet) => {
        const { service, cache } = build();
        cache.get.mockImplementation(redisGet);
        jest
          .spyOn(service as any, 'readFallbackPricingData')
          .mockReturnValue(fallbackAt([[NOW, 0.03]]));

        await expect(
          service.getCoinMarketData(AETERNITY_COIN_ID, 'usd'),
        ).resolves.toMatchObject({ currentPrice: 0.03, isFallback: true });
      },
    );

    it('still returns the fallback when caching it fails', async () => {
      const { service, cache } = build();
      cache.set.mockRejectedValue(new Error('redis down'));
      jest
        .spyOn(service as any, 'readFallbackPricingData')
        .mockReturnValue(fallbackAt([[NOW, 0.03]]));

      await expect(
        service.getCoinMarketData(AETERNITY_COIN_ID, 'usd'),
      ).resolves.toMatchObject({ currentPrice: 0.03, dataSource: 'fallback' });
    });

    it('reports no change from a single fallback price point', async () => {
      const { service } = build();
      jest
        .spyOn(service as any, 'readFallbackPricingData')
        .mockReturnValue(fallbackAt([[NOW, 0.03]]));

      await expect(
        service.getCoinMarketData(AETERNITY_COIN_ID, 'usd'),
      ).resolves.toMatchObject({
        currentPrice: 0.03,
        high24h: 0.03,
        low24h: 0.03,
        priceChange24h: 0,
        priceChangePercentage24h: 0,
        marketCap: 0,
        marketCapChange24h: 0,
        totalVolume: 0,
      });
    });

    it('takes the latest fallback point by timestamp, not by position', async () => {
      const { service } = build();
      jest.spyOn(service as any, 'readFallbackPricingData').mockReturnValue(
        fallbackAt([
          [NOW, 0.04],
          [NOW - DAY, 0.02],
        ]),
      );

      await expect(
        service.getCoinMarketData(AETERNITY_COIN_ID, 'usd'),
      ).resolves.toMatchObject({
        currentPrice: 0.04,
        priceChangePercentage24h: 100,
        high24h: 0.04,
        low24h: 0.02,
      });
    });

    it.each([
      ['another coin', 'bitcoin', 'usd', fallbackAt([[NOW, 0.03]])],
      ['another currency', AETERNITY_COIN_ID, 'eur', fallbackAt([[NOW, 0.03]])],
      [
        'a fallback file without prices',
        AETERNITY_COIN_ID,
        'usd',
        fallbackAt([]),
      ],
    ])(
      'throws 503 on an empty cache for %s',
      async (_label, coinId, currency, fallback) => {
        const { service } = build();
        jest
          .spyOn(service as any, 'readFallbackPricingData')
          .mockReturnValue(fallback);

        await expect(
          service.getCoinMarketData(coinId, currency),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
      },
    );

    it('throws 503 when the fallback file cannot be read', async () => {
      const { service } = build();
      jest
        .spyOn(service as any, 'readFallbackPricingData')
        .mockImplementation(() => {
          throw new Error('ENOENT');
        });

      await expect(
        service.getCoinMarketData(AETERNITY_COIN_ID, 'usd'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('getHistoricalPrice', () => {
    const rows: Array<[number, number]> = [
      [daysAgo(2), 0.02],
      [daysAgo(1), 0.021],
    ];

    it('serves the Redis copy without touching the database', async () => {
      const { service, cache, history } = build();
      cache.get.mockResolvedValue(rows);

      await expect(
        service.getHistoricalPrice(AETERNITY_COIN_ID, 'usd', 7, 'daily'),
      ).resolves.toBe(rows);
      expect(cache.get).toHaveBeenCalledWith(historicalKey(7, 'daily'));
      expect(history.getHistoricalPriceData).not.toHaveBeenCalled();
    });

    it.each([
      ['misses', async () => undefined],
      [
        'cannot be read',
        async () => {
          throw new Error('redis down');
        },
      ],
    ])(
      'serves and caches the stored rows for the requested window when Redis %s',
      async (_label, redisGet) => {
        const { service, cache, history } = build();
        cache.get.mockImplementation(redisGet);
        history.getHistoricalPriceData.mockResolvedValue(rows);

        await expect(
          service.getHistoricalPrice(AETERNITY_COIN_ID, 'usd', 30),
        ).resolves.toBe(rows);
        expect(history.getHistoricalPriceData).toHaveBeenCalledWith(
          AETERNITY_COIN_ID,
          'usd',
          daysAgo(30),
          NOW,
        );
        expect(cache.set).toHaveBeenCalledWith(historicalKey(30), rows, HOUR);
      },
    );

    it('still serves the stored rows when caching them fails', async () => {
      const { service, cache, history } = build();
      history.getHistoricalPriceData.mockResolvedValue(rows);
      cache.set.mockRejectedValue(new Error('redis down'));

      await expect(
        service.getHistoricalPrice(AETERNITY_COIN_ID, 'usd', 30),
      ).resolves.toBe(rows);
    });

    it.each([
      ['the database has no rows', {}, async () => []],
      [
        'the database query fails',
        {},
        async () => {
          throw new Error('db down');
        },
      ],
      ['there is no history store', { withHistory: false }, async () => []],
    ])(
      'falls back to the bundled JSON when %s',
      async (_label, options, dbQuery) => {
        const { service, history, useFallbackJson } = build(options);
        history.getHistoricalPriceData.mockImplementation(dbQuery);
        useFallbackJson();

        await expect(
          service.getHistoricalPrice(AETERNITY_COIN_ID, 'usd', 30),
        ).resolves.toEqual(FALLBACK_PRICES);
      },
    );

    it('never calls the CoinGecko API', async () => {
      const { service, useFallbackJson } = build();
      useFallbackJson();

      await service.getHistoricalPrice(AETERNITY_COIN_ID, 'usd', 1, 'hourly');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['has no prices array', () => ({ market_caps: [] })],
      [
        'cannot be read',
        () => {
          throw new Error('ENOENT');
        },
      ],
    ])(
      'returns an empty series when the fallback file %s',
      async (_label, readFile) => {
        const { service } = build();
        jest
          .spyOn(service as any, 'readFallbackPricingData')
          .mockImplementation(readFile);

        await expect(
          service.getHistoricalPrice(AETERNITY_COIN_ID, 'usd', 30),
        ).resolves.toEqual([]);
      },
    );
  });

  describe('bundled fallback JSON', () => {
    it('is parsed once and reused', () => {
      const { service } = build();

      const first = (service as any).readFallbackPricingData();

      expect((service as any).readFallbackPricingData()).toBe(first);
      expect(first?.prices?.length).toBeGreaterThan(0);
    });

    it('hands every caller its own copy of the price series', async () => {
      // PortfolioService sorts the series it gets in place.
      const { service } = build({ withHistory: false });
      const read = () =>
        service.getHistoricalPrice(AETERNITY_COIN_ID, 'usd', 30);

      const first = await read();
      expect(first.length).toBeGreaterThan(1);
      const firstTimestamp = first[0][0];
      first.sort((a, b) => b[0] - a[0]);
      first.length = 1;

      const second = await read();
      expect(second).not.toBe(first);
      expect(second.length).toBeGreaterThan(1);
      expect(second[0][0]).toBe(firstTimestamp);
    });
  });

  describe('refreshHistoricalPrice', () => {
    const refresh = (
      service: CoinGeckoService,
      days: number,
      interval?: 'daily' | 'hourly',
    ): Promise<Array<[number, number]>> =>
      (service as any).refreshHistoricalPrice(
        AETERNITY_COIN_ID,
        'usd',
        days,
        interval,
      );

    const requestedDays = () =>
      chartCalls().map((url) => url.searchParams.get('days'));

    it('serves the Redis copy without touching the database or the API', async () => {
      const { service, cache, history } = build();
      const cached: Array<[number, number]> = [[NOW, 0.02]];
      cache.get.mockResolvedValue(cached);

      await expect(refresh(service, 7, 'daily')).resolves.toBe(cached);
      expect(history.getHistoricalPriceData).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('recent windows (7 days or less)', () => {
      it('fetches the whole window when nothing is stored, keeping only in-window points', async () => {
        const { service, cache, history } = build();
        const inWindow: Array<[number, number]> = [
          [NOW - 6 * HOUR, 0.02],
          [NOW - HOUR, 0.021],
        ];
        fetchMock.mockResolvedValue({
          prices: [[daysAgo(2), 0.019], ...inWindow, [NOW + HOUR, 0.5]],
        });

        await expect(refresh(service, 1, 'hourly')).resolves.toEqual(inWindow);

        const [url] = chartCalls();
        expect(url.pathname).toBe(
          `/api/v3/coins/${AETERNITY_COIN_ID}/market_chart`,
        );
        expect(Object.fromEntries(url.searchParams)).toEqual({
          vs_currency: 'usd',
          days: '1',
          interval: 'hourly',
        });
        expect(history.savePriceData).toHaveBeenCalledWith(
          AETERNITY_COIN_ID,
          'usd',
          inWindow,
        );
        expect(cache.set).toHaveBeenCalledWith(
          historicalKey(1, 'hourly'),
          inWindow,
          HOUR,
        );
      });

      it('omits the interval parameter when none is given', async () => {
        const { service } = build();
        fetchMock.mockResolvedValue({ prices: [[NOW, 0.02]] });

        await refresh(service, 7);

        expect(chartCalls()[0].searchParams.has('interval')).toBe(false);
      });

      it('serves stored rows without calling the API when the newest point is under an hour old', async () => {
        const { service, cache, history } = build();
        const stored: Array<[number, number]> = [[NOW - 30 * 60 * 1000, 0.02]];
        history.getHistoricalPriceData.mockResolvedValue(stored);
        history.getLatestTimestamp.mockResolvedValue(NOW - 30 * 60 * 1000);

        await expect(refresh(service, 7, 'daily')).resolves.toBe(stored);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(cache.set).toHaveBeenCalledWith(
          historicalKey(7, 'daily'),
          stored,
          HOUR,
        );
      });

      it('still serves stored rows when caching them fails', async () => {
        const { service, cache, history } = build();
        const stored: Array<[number, number]> = [[NOW, 0.02]];
        history.getHistoricalPriceData.mockResolvedValue(stored);
        history.getLatestTimestamp.mockResolvedValue(NOW);
        cache.set.mockRejectedValue(new Error('redis down'));

        await expect(refresh(service, 7, 'daily')).resolves.toBe(stored);
      });

      it('fetches only the days since the newest stored point and saves only newer points', async () => {
        const { service, history } = build();
        const latest = NOW - 30 * HOUR;
        const stored: Array<[number, number]> = [
          [daysAgo(3), 0.018],
          [latest, 0.019],
        ];
        const newer: Array<[number, number]> = [
          [NOW - 10 * HOUR, 0.02],
          [NOW, 0.021],
        ];
        history.getHistoricalPriceData.mockResolvedValue(stored);
        history.getLatestTimestamp.mockResolvedValue(latest);
        fetchMock.mockResolvedValue({ prices: [[latest, 0.0195], ...newer] });

        const result = await refresh(service, 7, 'daily');

        expect(requestedDays()).toEqual(['2']);
        expect(history.savePriceData).toHaveBeenCalledWith(
          AETERNITY_COIN_ID,
          'usd',
          newer,
        );
        expect(result).toEqual([...stored, ...newer]);
      });

      it('fetches the whole window when the newest stored point cannot be read', async () => {
        const { service, history } = build();
        history.getLatestTimestamp.mockRejectedValue(new Error('db down'));
        fetchMock.mockResolvedValue({ prices: [[NOW, 0.02]] });

        await expect(refresh(service, 7, 'daily')).resolves.toEqual([
          [NOW, 0.02],
        ]);
        expect(requestedDays()).toEqual(['7']);
      });

      it('keeps going when the stored rows cannot be read', async () => {
        const { service, history } = build();
        history.getHistoricalPriceData.mockRejectedValue(new Error('db down'));
        fetchMock.mockResolvedValue({ prices: [[NOW, 0.02]] });

        await expect(refresh(service, 7, 'daily')).resolves.toEqual([
          [NOW, 0.02],
        ]);
      });
    });

    describe('long windows (more than 7 days)', () => {
      it('serves stored rows without calling the API when nothing is missing', async () => {
        const { service, history } = build();
        const stored: Array<[number, number]> = [[daysAgo(100), 0.03]];
        history.getHistoricalPriceData.mockResolvedValue(stored);

        await expect(refresh(service, 365, 'daily')).resolves.toBe(stored);
        expect(history.getMissingDataRanges).toHaveBeenCalledWith(
          AETERNITY_COIN_ID,
          'usd',
          daysAgo(365),
          NOW,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('sizes the request to the largest missing range and merges it with stored rows', async () => {
        const { service, history } = build();
        const stored: Array<[number, number]> = [
          [daysAgo(10), 0.03],
          [daysAgo(3), 0.031],
        ];
        const fetched: Array<[number, number]> = [
          [daysAgo(2), 0.032],
          [NOW, 0.033],
        ];
        history.getHistoricalPriceData.mockResolvedValue(stored);
        history.getMissingDataRanges.mockResolvedValue([
          [daysAgo(10) + 1, daysAgo(9)],
          [daysAgo(3) + 1, NOW],
        ]);
        fetchMock.mockResolvedValue({ prices: fetched });

        const result = await refresh(service, 365, 'daily');

        expect(requestedDays()).toEqual(['3']);
        expect(result).toEqual([...stored, ...fetched]);
      });

      it('fetches the whole window when the missing ranges cannot be computed', async () => {
        const { service, history } = build();
        history.getMissingDataRanges.mockRejectedValue(new Error('db down'));
        fetchMock.mockResolvedValue({ prices: [[NOW, 0.02]] });

        await refresh(service, 30, 'daily');

        expect(requestedDays()).toEqual(['30']);
      });

      it('fetches the whole window without a history store', async () => {
        const { service } = build({ withHistory: false });
        fetchMock.mockResolvedValue({
          prices: [
            [daysAgo(400), 0.01],
            [NOW, 0.02],
          ],
        });

        await expect(refresh(service, 365, 'daily')).resolves.toEqual([
          [NOW, 0.02],
        ]);
        expect(requestedDays()).toEqual(['365']);
      });
    });

    describe('when CoinGecko does not deliver', () => {
      const stored: Array<[number, number]> = [[NOW - 2 * HOUR, 0.02]];
      const outcomes: Array<[string, () => void]> = [
        [
          'rate-limits the request',
          () => fetchMock.mockResolvedValue({ status: { error_code: 429 } }),
        ],
        [
          'returns another API error',
          () =>
            fetchMock.mockResolvedValue({
              status: { error_code: 500, error_message: 'oops' },
            }),
        ],
        [
          'returns no prices',
          () => fetchMock.mockResolvedValue({ prices: [] }),
        ],
        [
          'cannot be reached',
          () => fetchMock.mockRejectedValue(new Error('down')),
        ],
      ];

      it.each(outcomes)(
        'serves the stored rows when it %s',
        async (_label, arrange) => {
          const { service, history } = build();
          history.getHistoricalPriceData.mockResolvedValue(stored);
          history.getLatestTimestamp.mockResolvedValue(NOW - 2 * HOUR);
          arrange();

          await expect(refresh(service, 7, 'daily')).resolves.toBe(stored);
          expect(history.savePriceData).not.toHaveBeenCalled();
        },
      );

      it.each(outcomes)(
        'falls back to the bundled JSON when nothing is stored and it %s',
        async (_label, arrange) => {
          const { service, history, useFallbackJson } = build();
          useFallbackJson();
          arrange();

          await expect(refresh(service, 7, 'daily')).resolves.toEqual(
            FALLBACK_PRICES,
          );
          expect(history.savePriceData).not.toHaveBeenCalled();
        },
      );

      it('prefers a cache entry written meanwhile over the JSON fallback when rate-limited', async () => {
        const { service, cache, useFallbackJson } = build();
        const meanwhile: Array<[number, number]> = [[NOW, 0.022]];
        cache.get
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(meanwhile);
        useFallbackJson();
        fetchMock.mockResolvedValue({ status: { error_code: 429 } });

        await expect(refresh(service, 7, 'daily')).resolves.toBe(meanwhile);
      });

      it('falls back to the bundled JSON when rate-limited and the cache cannot be read', async () => {
        const { service, cache, useFallbackJson } = build();
        cache.get.mockRejectedValue(new Error('redis down'));
        useFallbackJson();
        fetchMock.mockResolvedValue({ status: { error_code: 429 } });

        await expect(refresh(service, 7, 'daily')).resolves.toEqual(
          FALLBACK_PRICES,
        );
      });
    });

    it('still returns and caches the merged series when saving to the database fails', async () => {
      const { service, cache, history } = build();
      history.savePriceData.mockRejectedValue(new Error('db down'));
      fetchMock.mockResolvedValue({ prices: [[NOW, 0.02]] });

      await expect(refresh(service, 7, 'daily')).resolves.toEqual([
        [NOW, 0.02],
      ]);
      expect(cache.set).toHaveBeenCalledWith(
        historicalKey(7, 'daily'),
        [[NOW, 0.02]],
        HOUR,
      );
    });

    it('still returns the merged series when caching it fails', async () => {
      const { service, cache } = build();
      cache.set.mockRejectedValue(new Error('redis down'));
      fetchMock.mockResolvedValue({ prices: [[NOW, 0.02]] });

      await expect(refresh(service, 7, 'daily')).resolves.toEqual([
        [NOW, 0.02],
      ]);
    });

    it('falls back to the bundled JSON when every fetched point is outside the window', async () => {
      const { service, cache, useFallbackJson } = build();
      useFallbackJson();
      fetchMock.mockResolvedValue({ prices: [[daysAgo(30), 0.02]] });

      await expect(refresh(service, 7, 'daily')).resolves.toEqual(
        FALLBACK_PRICES,
      );
      expect(cache.set).not.toHaveBeenCalled();
    });
  });
});

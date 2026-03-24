import moment from 'moment';
import { PortfolioService } from './portfolio.service';
import { batchTimestampToAeHeight } from '@/utils/getBlochHeight';
import { TokenPnlResult } from './bcl-pnl.service';

jest.mock('@/utils/getBlochHeight', () => ({
  batchTimestampToAeHeight: jest.fn(),
}));

describe('PortfolioService', () => {
  const basePnlResult: TokenPnlResult = {
    pnls: {},
    totalCostBasisAe: 0,
    totalCostBasisUsd: 0,
    totalCurrentValueAe: 0,
    totalCurrentValueUsd: 0,
    totalGainAe: 0,
    totalGainUsd: 0,
  };

  const createService = () => {
    const aeSdkService = {
      sdk: {
        getBalance: jest.fn(),
      },
    };
    const coinGeckoService = {
      fetchHistoricalPrice: jest.fn(),
      getPriceData: jest.fn(),
    };
    const coinHistoricalPriceService = {
      // Default: no DB data → falls back to coinGeckoService.fetchHistoricalPrice
      getHistoricalPriceData: jest.fn().mockResolvedValue([]),
    };
    const bclPnlService = {
      calculateTokenPnls: jest.fn(),
      calculateTokenPnlsBatch: jest.fn(),
    };

    const service = new PortfolioService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      aeSdkService as any,
      coinGeckoService as any,
      coinHistoricalPriceService as any,
      bclPnlService as any,
    );

    return {
      service,
      aeSdkService,
      coinGeckoService,
      coinHistoricalPriceService,
      bclPnlService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('limits concurrent balance fetches to snapshotConcurrency', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    // Assign heights that land in different 300-block buckets so each
    // snapshot triggers its own getBalance call (bucket = i * 300).
    (batchTimestampToAeHeight as jest.Mock).mockImplementation(
      async (timestamps: number[]) => {
        const map = new Map<number, number>();
        timestamps.forEach((ts, i) => map.set(ts, i * 300));
        return map;
      },
    );

    coinGeckoService.fetchHistoricalPrice.mockResolvedValue([
      [Date.UTC(2026, 0, 10), 10],
      [Date.UTC(2026, 0, 1), 1],
    ]);
    coinGeckoService.getPriceData.mockResolvedValue({ usd: 10 });

    // PNL batch covers the exact heights assigned above (i * 300)
    bclPnlService.calculateTokenPnlsBatch.mockImplementation(
      async (_addr: string, heights: number[]) => {
        const map = new Map<number, TokenPnlResult>();
        heights.forEach((h) => map.set(h, basePnlResult));
        return map;
      },
    );

    let inFlight = 0;
    let maxInFlight = 0;
    aeSdkService.sdk.getBalance.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return '1000000000000000000';
    });

    const startDate = moment.utc('2026-01-01T00:00:00.000Z');
    const endDate = moment.utc('2026-01-10T00:00:00.000Z');

    const snapshots = await service.getPortfolioHistory('ak_test', {
      startDate,
      endDate,
      interval: 86400,
    });

    expect(snapshots).toHaveLength(10);
    // PNL is pre-computed in a single batch call
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledTimes(1);
    // All 10 heights land in different 300-block buckets, so 10 balance calls
    expect(aeSdkService.sdk.getBalance).toHaveBeenCalledTimes(10);
    // Balance concurrency cap is 15
    expect(maxInFlight).toBeLessThanOrEqual(15);
  });

  it('deduplicates block heights so balance and PNL are only fetched once per unique height', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    // All timestamps map to the same block height
    (batchTimestampToAeHeight as jest.Mock).mockImplementation(
      async (timestamps: number[]) => {
        const map = new Map<number, number>();
        timestamps.forEach((ts) => map.set(ts, 123));
        return map;
      },
    );

    coinGeckoService.fetchHistoricalPrice.mockResolvedValue([
      [Date.UTC(2026, 0, 3), 3],
      [Date.UTC(2026, 0, 1), 1],
      [Date.UTC(2026, 0, 2), 2],
    ]);
    coinGeckoService.getPriceData.mockResolvedValue({ usd: 99 });

    const pnlMap = new Map([[123, basePnlResult]]);
    bclPnlService.calculateTokenPnlsBatch.mockResolvedValue(pnlMap);

    aeSdkService.sdk.getBalance.mockResolvedValue('1000000000000000000');

    const snapshots = await service.getPortfolioHistory('ak_test', {
      startDate: moment.utc('2026-01-01T00:00:00.000Z'),
      endDate: moment.utc('2026-01-03T00:00:00.000Z'),
      interval: 86400,
    });

    expect(snapshots).toHaveLength(3);
    // All 3 timestamps share height 123, so balance is fetched once
    expect(aeSdkService.sdk.getBalance).toHaveBeenCalledTimes(1);
    // Batch PNL is called once with deduplicated heights
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledTimes(1);
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledWith(
      'ak_test',
      [123],
      undefined,
    );
    // Per-snapshot price is still resolved per timestamp, not per block height
    expect(snapshots.map((snapshot) => snapshot.ae_price)).toEqual([1, 2, 3]);
  });

  it('buckets block heights to multiples of 300 to share getBalance calls', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    // 4 timestamps that map to 3 distinct exact heights, but only 2 distinct
    // 300-block buckets:  100 → bucket 0,  250 → bucket 0,  350 → bucket 300,  599 → bucket 300
    (batchTimestampToAeHeight as jest.Mock).mockImplementation(
      async (timestamps: number[]) => {
        const heights = [100, 250, 350, 599];
        const map = new Map<number, number>();
        timestamps.forEach((ts, i) => map.set(ts, heights[i]));
        return map;
      },
    );

    coinGeckoService.fetchHistoricalPrice.mockResolvedValue([
      [Date.UTC(2026, 0, 4), 4],
      [Date.UTC(2026, 0, 1), 1],
      [Date.UTC(2026, 0, 2), 2],
      [Date.UTC(2026, 0, 3), 3],
    ]);
    coinGeckoService.getPriceData.mockResolvedValue({ usd: 5 });
    aeSdkService.sdk.getBalance.mockResolvedValue('1000000000000000000');

    bclPnlService.calculateTokenPnlsBatch.mockImplementation(
      async (_addr: string, heights: number[]) => {
        const map = new Map<number, TokenPnlResult>();
        heights.forEach((h) => map.set(h, basePnlResult));
        return map;
      },
    );

    const snapshots = await service.getPortfolioHistory('ak_test', {
      startDate: moment.utc('2026-01-01T00:00:00.000Z'),
      endDate: moment.utc('2026-01-04T00:00:00.000Z'),
      interval: 86400,
    });

    expect(snapshots).toHaveLength(4);
    // Heights 100 and 250 → bucket 0; heights 350 and 599 → bucket 300.
    // Only 2 unique buckets → exactly 2 getBalance calls.
    expect(aeSdkService.sdk.getBalance).toHaveBeenCalledTimes(2);
    // getBalance is called with the bucket boundaries, not the raw heights
    const calledHeights = aeSdkService.sdk.getBalance.mock.calls.map(
      ([, opts]: [any, any]) => opts.height,
    );
    expect(calledHeights).toEqual(expect.arrayContaining([0, 300]));
  });

  it('pre-computes both cumulative and range PNL maps when range PNL is requested', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    (batchTimestampToAeHeight as jest.Mock).mockImplementation(
      async (timestamps: number[]) => {
        const map = new Map<number, number>();
        timestamps.forEach((ts, i) => map.set(ts, 100 + i));
        return map;
      },
    );
    coinGeckoService.fetchHistoricalPrice.mockResolvedValue([
      [Date.UTC(2026, 0, 3), 3],
      [Date.UTC(2026, 0, 1), 1],
      [Date.UTC(2026, 0, 2), 2],
    ]);
    coinGeckoService.getPriceData.mockResolvedValue({ usd: 5 });
    aeSdkService.sdk.getBalance.mockResolvedValue('1000000000000000000');

    bclPnlService.calculateTokenPnlsBatch.mockImplementation(
      async (_addr: string, heights: number[]) => {
        const map = new Map<number, TokenPnlResult>();
        heights.forEach((h) => map.set(h, basePnlResult));
        return map;
      },
    );

    const snapshots = await service.getPortfolioHistory('ak_test', {
      startDate: moment.utc('2026-01-01T00:00:00.000Z'),
      endDate: moment.utc('2026-01-03T00:00:00.000Z'),
      interval: 86400,
      includePnl: true,
      useRangeBasedPnl: true,
    });

    expect(snapshots).toHaveLength(3);
    // Called twice: once for cumulative, once for range-based
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledTimes(2);
    // startBlockHeight = blockHeights[0] = 100 (timestamps[0] maps to 100+0)
    const calls = bclPnlService.calculateTokenPnlsBatch.mock.calls;
    expect(calls[0][2]).toBeUndefined(); // cumulative: no fromBlockHeight
    expect(calls[1][2]).toBe(100); // range: fromBlockHeight = blockHeights[0]
  });

  it('uses coin_historical_prices DB table when available, skipping CoinGecko', async () => {
    const {
      service,
      aeSdkService,
      coinGeckoService,
      coinHistoricalPriceService,
      bclPnlService,
    } = createService();

    (batchTimestampToAeHeight as jest.Mock).mockImplementation(
      async (timestamps: number[]) => {
        const map = new Map<number, number>();
        timestamps.forEach((ts, i) => map.set(ts, (i + 1) * 300));
        return map;
      },
    );

    // DB returns prices in ascending order (as the repository does)
    coinHistoricalPriceService.getHistoricalPriceData.mockResolvedValue([
      [Date.UTC(2026, 0, 1), 1],
      [Date.UTC(2026, 0, 2), 2],
      [Date.UTC(2026, 0, 3), 3],
    ]);
    coinGeckoService.getPriceData.mockResolvedValue({ usd: 99 });

    bclPnlService.calculateTokenPnlsBatch.mockImplementation(
      async (_addr: string, heights: number[]) => {
        const map = new Map<number, TokenPnlResult>();
        heights.forEach((h) => map.set(h, basePnlResult));
        return map;
      },
    );
    aeSdkService.sdk.getBalance.mockResolvedValue('1000000000000000000');

    const snapshots = await service.getPortfolioHistory('ak_test', {
      startDate: moment.utc('2026-01-01T00:00:00.000Z'),
      endDate: moment.utc('2026-01-03T00:00:00.000Z'),
      interval: 86400,
    });

    expect(snapshots).toHaveLength(3);
    // Prices come from DB — CoinGecko historical endpoint is never called
    expect(coinGeckoService.fetchHistoricalPrice).not.toHaveBeenCalled();
    // DB service was queried for the needed range
    expect(
      coinHistoricalPriceService.getHistoricalPriceData,
    ).toHaveBeenCalledTimes(1);
    // Correct prices are assigned to each snapshot
    expect(snapshots.map((s) => s.ae_price)).toEqual([1, 2, 3]);
  });
});

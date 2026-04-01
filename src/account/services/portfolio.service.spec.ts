import moment from 'moment';
import { PortfolioService } from './portfolio.service';
import { batchTimestampToAeHeight } from '@/utils/getBlochHeight';
import { DailyPnlWindow, TokenPnlResult } from './bcl-pnl.service';
import { fetchJson } from '@/utils/common';

jest.mock('@/utils/getBlochHeight', () => ({
  batchTimestampToAeHeight: jest.fn(),
}));

jest.mock('@/utils/common', () => ({
  fetchJson: jest.fn(),
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
      getHistoricalPrice: jest.fn(),
      getPriceData: jest.fn(),
    };
    const coinHistoricalPriceService = {
      // Default: no DB data -> falls back to coinGeckoService.getHistoricalPrice
      getHistoricalPriceData: jest.fn().mockResolvedValue([]),
    };
    const bclPnlService = {
      calculateTokenPnls: jest.fn(),
      calculateTokenPnlsBatch: jest.fn(),
      calculateDailyPnlBatch: jest.fn(),
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
    (fetchJson as jest.Mock).mockResolvedValue(null);
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

    coinGeckoService.getHistoricalPrice.mockResolvedValue([
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
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledTimes(1);
    expect(aeSdkService.sdk.getBalance).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBeLessThanOrEqual(15);
  });

  it('deduplicates block heights so balance and PNL are only fetched once per unique height', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    (batchTimestampToAeHeight as jest.Mock).mockImplementation(
      async (timestamps: number[]) => {
        const map = new Map<number, number>();
        timestamps.forEach((ts) => map.set(ts, 123));
        return map;
      },
    );

    coinGeckoService.getHistoricalPrice.mockResolvedValue([
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
    expect(aeSdkService.sdk.getBalance).toHaveBeenCalledTimes(1);
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledTimes(1);
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledWith(
      'ak_test',
      [123],
      undefined,
    );
    expect(snapshots.map((snapshot) => snapshot.ae_price)).toEqual([1, 2, 3]);
  });

  it('buckets block heights to multiples of 300 to share getBalance calls', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    (batchTimestampToAeHeight as jest.Mock).mockImplementation(
      async (timestamps: number[]) => {
        const heights = [100, 250, 350, 599];
        const map = new Map<number, number>();
        timestamps.forEach((ts, i) => map.set(ts, heights[i]));
        return map;
      },
    );

    coinGeckoService.getHistoricalPrice.mockResolvedValue([
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
    expect(aeSdkService.sdk.getBalance).toHaveBeenCalledTimes(2);
    const calledHeights = aeSdkService.sdk.getBalance.mock.calls.map(
      ([, opts]: [any, any]) => opts.height,
    );
    expect(calledHeights).toEqual(expect.arrayContaining([0, 300]));
  });

  it('calls calculateDailyPnlBatch with per-day windows when range PNL is requested', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    const ts1 = moment.utc('2026-01-01T00:00:00.000Z');
    const ts2 = moment.utc('2026-01-02T00:00:00.000Z');
    const ts3 = moment.utc('2026-01-03T00:00:00.000Z');

    (batchTimestampToAeHeight as jest.Mock).mockImplementation(
      async (timestamps: number[]) => {
        const map = new Map<number, number>();
        timestamps.forEach((ts, i) => map.set(ts, 100 + i));
        return map;
      },
    );
    coinGeckoService.getHistoricalPrice.mockResolvedValue([
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

    bclPnlService.calculateDailyPnlBatch.mockImplementation(
      async (_addr: string, windows: DailyPnlWindow[]) => {
        const map = new Map<number, TokenPnlResult>();
        windows.forEach((w) => map.set(w.snapshotTs, basePnlResult));
        return map;
      },
    );

    const snapshots = await service.getPortfolioHistory('ak_test', {
      startDate: ts1,
      endDate: ts3,
      interval: 86400,
      includePnl: true,
      useRangeBasedPnl: true,
    });

    expect(snapshots).toHaveLength(3);

    // Cumulative map still uses calculateTokenPnlsBatch (once, no fromBlockHeight)
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledTimes(1);
    expect(
      bclPnlService.calculateTokenPnlsBatch.mock.calls[0][2],
    ).toBeUndefined();

    // Daily PnL now uses calculateDailyPnlBatch
    expect(bclPnlService.calculateDailyPnlBatch).toHaveBeenCalledTimes(1);
    const [, windows] = bclPnlService.calculateDailyPnlBatch.mock.calls[0] as [
      string,
      DailyPnlWindow[],
    ];
    expect(windows).toHaveLength(3);

    // First window: zero-width (dayStart === snapshotTs)
    expect(windows[0].snapshotTs).toBe(ts1.valueOf());
    expect(windows[0].dayStartTs).toBe(ts1.valueOf());

    // Second window: [ts1, ts2)
    expect(windows[1].snapshotTs).toBe(ts2.valueOf());
    expect(windows[1].dayStartTs).toBe(ts1.valueOf());

    // Third window: [ts2, ts3)
    expect(windows[2].snapshotTs).toBe(ts3.valueOf());
    expect(windows[2].dayStartTs).toBe(ts2.valueOf());
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
    expect(coinGeckoService.getHistoricalPrice).not.toHaveBeenCalled();
    expect(
      coinHistoricalPriceService.getHistoricalPriceData,
    ).toHaveBeenCalledTimes(1);
    expect(snapshots.map((s) => s.ae_price)).toEqual([1, 2, 3]);
  });

  it('resolves chain names to account pubkeys before balance and pnl lookups', async () => {
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
        timestamps.forEach((ts) => map.set(ts, 300));
        return map;
      },
    );
    (fetchJson as jest.Mock).mockResolvedValue({
      owner: 'ak_owner',
      pointers: [{ key: 'account_pubkey', id: 'ak_resolved' }],
    });
    coinGeckoService.getPriceData.mockResolvedValue({ usd: 99 });
    coinHistoricalPriceService.getHistoricalPriceData.mockResolvedValue([
      [Date.UTC(2026, 0, 1), 1],
    ]);
    aeSdkService.sdk.getBalance.mockResolvedValue('1000000000000000000');
    bclPnlService.calculateTokenPnlsBatch.mockResolvedValue(
      new Map([[300, basePnlResult]]),
    );

    await service.getPortfolioHistory('mybtc.chain', {
      startDate: moment.utc('2026-01-01T00:00:00.000Z'),
      endDate: moment.utc('2026-01-01T00:00:00.000Z'),
      interval: 86400,
    });

    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://mainnet.aeternity.io/v3/names/mybtc.chain',
      ),
    );
    expect(aeSdkService.sdk.getBalance).toHaveBeenCalledWith(
      'ak_resolved',
      expect.objectContaining({ height: 300 }),
    );
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledWith(
      'ak_resolved',
      [300],
      undefined,
    );
  });

  describe('getPnlTimeSeries', () => {
    it('calls calculateDailyPnlBatch and maps gain values', async () => {
      const { service, bclPnlService } = createService();

      const ts0 = moment('2026-01-01T00:00:00Z');
      const ts1 = moment('2026-01-02T00:00:00Z');
      const ts2 = moment('2026-01-03T00:00:00Z');

      const pnlMap = new Map([
        [ts1.valueOf(), { ...basePnlResult, totalGainAe: 5, totalGainUsd: 10 }],
        [ts2.valueOf(), { ...basePnlResult, totalGainAe: 3, totalGainUsd: 6 }],
      ]);
      bclPnlService.calculateDailyPnlBatch.mockResolvedValue(pnlMap);

      const result = await service.getPnlTimeSeries('ak_test', {
        startDate: ts0,
        endDate: ts2,
        interval: 86400,
      });

      expect(bclPnlService.calculateDailyPnlBatch).toHaveBeenCalledTimes(1);
      // Should NOT call any balance or block-height resolution
      expect(bclPnlService.calculateTokenPnlsBatch).not.toHaveBeenCalled();

      // ts0 has no entry in map → gain 0
      expect(result[0].gain).toEqual({ ae: 0, usd: 0 });
      expect(result[1].gain).toEqual({ ae: 5, usd: 10 });
      expect(result[2].gain).toEqual({ ae: 3, usd: 6 });
    });

    it('builds correct daily windows from timestamps', async () => {
      const { service, bclPnlService } = createService();
      bclPnlService.calculateDailyPnlBatch.mockResolvedValue(new Map());

      const start = moment('2026-01-01T00:00:00Z');
      const end = moment('2026-01-03T00:00:00Z');

      await service.getPnlTimeSeries('ak_test', {
        startDate: start,
        endDate: end,
        interval: 86400,
      });

      const [, windows]: [string, DailyPnlWindow[]] =
        bclPnlService.calculateDailyPnlBatch.mock.calls[0];

      // First window: zero-width (no sells can fall in an empty range)
      expect(windows[0].dayStartTs).toBe(windows[0].snapshotTs);
      // Second window: covers [day0, day1)
      expect(windows[1].dayStartTs).toBe(windows[0].snapshotTs);
      expect(windows[1].snapshotTs).toBe(windows[1].dayStartTs + 86400 * 1000);
    });

    it('returns empty array when start is after end', async () => {
      const { service, bclPnlService } = createService();
      bclPnlService.calculateDailyPnlBatch.mockResolvedValue(new Map());

      const result = await service.getPnlTimeSeries('ak_test', {
        startDate: moment('2026-01-10T00:00:00Z'),
        endDate: moment('2026-01-01T00:00:00Z'),
        interval: 86400,
      });

      expect(result).toEqual([]);
      expect(bclPnlService.calculateDailyPnlBatch).not.toHaveBeenCalled();
    });
  });
});

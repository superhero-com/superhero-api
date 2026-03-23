import moment from 'moment';
import { PortfolioService } from './portfolio.service';
import { timestampToAeHeight } from '@/utils/getBlochHeight';

jest.mock('@/utils/getBlochHeight', () => ({
  timestampToAeHeight: jest.fn(),
}));

describe('PortfolioService', () => {
  const basePnlResult = {
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
    const bclPnlService = {
      calculateTokenPnls: jest.fn(),
    };

    const service = new PortfolioService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      aeSdkService as any,
      coinGeckoService as any,
      bclPnlService as any,
    );

    return {
      service,
      aeSdkService,
      coinGeckoService,
      bclPnlService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('limits concurrent per-timestamp pnl work', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    (timestampToAeHeight as jest.Mock).mockImplementation(async (ts: number) => ts);
    coinGeckoService.fetchHistoricalPrice.mockResolvedValue([
      [Date.UTC(2026, 0, 10), 10],
      [Date.UTC(2026, 0, 1), 1],
    ]);
    coinGeckoService.getPriceData.mockResolvedValue({ usd: 10 });
    aeSdkService.sdk.getBalance.mockResolvedValue('1000000000000000000');

    let inFlight = 0;
    let maxInFlight = 0;
    bclPnlService.calculateTokenPnls.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return basePnlResult;
    });

    const startDate = moment.utc('2026-01-01T00:00:00.000Z');
    const endDate = moment.utc('2026-01-10T00:00:00.000Z');

    const snapshots = await service.getPortfolioHistory('ak_test', {
      startDate,
      endDate,
      interval: 86400,
    });

    expect(snapshots).toHaveLength(10);
    expect(bclPnlService.calculateTokenPnls).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });

  it('memoizes repeated block-height lookups and keeps historical pricing intact', async () => {
    const { service, aeSdkService, coinGeckoService, bclPnlService } =
      createService();

    (timestampToAeHeight as jest.Mock).mockResolvedValue(123);
    coinGeckoService.fetchHistoricalPrice.mockResolvedValue([
      [Date.UTC(2026, 0, 3), 3],
      [Date.UTC(2026, 0, 1), 1],
      [Date.UTC(2026, 0, 2), 2],
    ]);
    coinGeckoService.getPriceData.mockResolvedValue({ usd: 99 });
    aeSdkService.sdk.getBalance.mockResolvedValue('1000000000000000000');
    bclPnlService.calculateTokenPnls.mockResolvedValue(basePnlResult);

    const snapshots = await service.getPortfolioHistory('ak_test', {
      startDate: moment.utc('2026-01-01T00:00:00.000Z'),
      endDate: moment.utc('2026-01-03T00:00:00.000Z'),
      interval: 86400,
    });

    expect(snapshots).toHaveLength(3);
    expect(aeSdkService.sdk.getBalance).toHaveBeenCalledTimes(1);
    expect(bclPnlService.calculateTokenPnls).toHaveBeenCalledTimes(1);
    expect(snapshots.map((snapshot) => snapshot.ae_price)).toEqual([1, 2, 3]);
  });
});

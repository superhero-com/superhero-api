import { BigNumber } from 'bignumber.js';
import moment from 'moment';
import { CacheDailyAnalyticsDataService } from './cache-daily-analytics-data.service';

const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';

describe('CacheDailyAnalyticsDataService.getDateRangeAnalyticsLive', () => {
  it('computes a year of active days with at most 8 queries in flight', async () => {
    const days = Array.from({ length: 366 }, (_, i) =>
      moment('2024-01-01').add(i, 'day').toDate(),
    );
    let inFlight = 0;
    let peakInFlight = 0;
    const slowQuery = <T>(value: T) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return new Promise<T>((resolve) =>
        setImmediate(() => {
          inFlight -= 1;
          resolve(value);
        }),
      );
    };
    const transactionsRepository = {
      query: jest
        .fn()
        .mockResolvedValueOnce(
          days.map((day) => ({
            day,
            total_transactions: 2,
            total_active_accounts: 1,
            total_volume: '1.5',
            total_created_tokens: 0,
          })),
        )
        .mockImplementation(() => slowQuery([{ total: '10' }])),
    };
    const tokensRepository = { count: jest.fn(() => slowQuery(3)) };
    const service = new CacheDailyAnalyticsDataService(
      {} as any,
      transactionsRepository as any,
      tokensRepository as any,
    );

    const result = await service.getDateRangeAnalyticsLive(
      days[0],
      days[days.length - 1],
      ADDRESS,
    );

    // 4 days at a time, each running its token count and market-cap query.
    expect(peakInFlight).toBe(8);
    expect(result.map((row) => row.date)).toEqual(
      days.map((day) => moment(day).format('YYYY-MM-DD')),
    );
    expect(result[0]).toEqual({
      date: '2024-01-01',
      total_market_cap_sum: new BigNumber('10'),
      total_volume_sum: new BigNumber('1.5'),
      total_tokens: 3,
      total_transactions: 2,
      total_created_tokens: 0,
      total_active_accounts: 1,
    });
  });
});

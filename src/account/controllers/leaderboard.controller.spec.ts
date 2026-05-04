import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from '../services/leaderboard.service';

describe('LeaderboardController', () => {
  const buildService = (
    result: Awaited<ReturnType<LeaderboardService['getLeaders']>>,
  ) => {
    const getLeaders = jest.fn().mockResolvedValue(result);
    return {
      service: { getLeaders } as unknown as LeaderboardService,
      getLeaders,
    };
  };

  it('reports totalPages = 0 when there are no candidates', async () => {
    const { service } = buildService({
      items: [],
      totalCandidates: 0,
      page: 1,
      limit: 10,
      window: '7d',
      sortBy: 'pnl',
      sortDir: 'DESC',
    });
    const controller = new LeaderboardController(service);

    const response = await controller.getLeaderboard({});

    expect(response.items).toEqual([]);
    expect(response.meta).toMatchObject({
      page: 1,
      limit: 10,
      totalItems: 0,
      totalPages: 0,
      window: '7d',
      sortBy: 'pnl',
      sortDir: 'DESC',
    });
    expect(response.meta.timeFilter).toBeUndefined();
  });

  it('rounds totalPages up for partial last pages', async () => {
    const { service } = buildService({
      items: [],
      totalCandidates: 31,
      page: 1,
      limit: 10,
      window: '7d',
      sortBy: 'pnl',
      sortDir: 'DESC',
    });
    const controller = new LeaderboardController(service);

    const response = await controller.getLeaderboard({});

    expect(response.meta.totalPages).toBe(4);
    expect(response.meta.totalItems).toBe(31);
  });

  it('forwards the query DTO straight to the service', async () => {
    const { service, getLeaders } = buildService({
      items: [],
      totalCandidates: 0,
      page: 3,
      limit: 5,
      window: '30d',
      sortBy: 'roi',
      sortDir: 'ASC',
    });
    const controller = new LeaderboardController(service);

    await controller.getLeaderboard({
      window: '30d',
      sortBy: 'roi',
      sortDir: 'ASC',
      page: 3,
      limit: 5,
      startDate: '2026-04-28T10:00:00.000Z',
      endDate: '2026-04-28T12:00:00.000Z',
      tradingOnly: true,
    });

    expect(getLeaders).toHaveBeenCalledWith({
      window: '30d',
      sortBy: 'roi',
      sortDir: 'ASC',
      page: 3,
      limit: 5,
      startDate: '2026-04-28T10:00:00.000Z',
      endDate: '2026-04-28T12:00:00.000Z',
      tradingOnly: true,
    });
  });

  it('serializes timeFilter dates as ISO strings and returns selected-period metrics', async () => {
    const start = new Date('2026-04-28T10:00:00.000Z');
    const end = new Date('2026-04-28T12:00:00.000Z');
    const { service } = buildService({
      items: [
        {
          address: 'ak_test',
          chain_name: 'alice',
          aum_usd: 100,
          pnl_usd: 25,
          roi_pct: 33.3333333333,
          mdd_pct: 3,
          buy_count: 4,
          sell_count: 2,
          created_tokens_count: 0,
          owned_trends_count: 0,
          portfolio_value_usd_sparkline: [],
          volume_usd: 123,
        },
      ],
      totalCandidates: 1,
      page: 1,
      limit: 18,
      window: '30d',
      sortBy: 'aum',
      sortDir: 'DESC',
      timeFilter: { start, end },
    });
    const controller = new LeaderboardController(service);

    const response = await controller.getLeaderboard({
      window: '30d',
      sortBy: 'aum',
      startDate: '2026-04-28T10:00:00.000Z',
      endDate: '2026-04-28T12:00:00.000Z',
    });

    expect(response.meta.timeFilter).toEqual({
      start: '2026-04-28T10:00:00.000Z',
      end: '2026-04-28T12:00:00.000Z',
    });
    expect(response.meta.totalPages).toBe(1);
    expect(response.items[0]).toMatchObject({
      pnl_usd: 25,
      roi_pct: 33.3333333333,
      buy_count: 4,
      sell_count: 2,
      volume_usd: 123,
    });
    expect(response.items[0].active_period).toBeUndefined();
  });
});

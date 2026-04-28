import { BadRequestException } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';

describe('LeaderboardService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  type MockRow = Record<string, unknown>;

  const createService = (
    rows: MockRow[] = [],
    totalCount: number | string = 0,
  ) => {
    const query = jest.fn((sql: string) => {
      const isCount =
        sql.includes('SELECT COUNT(*)::int AS total_count') &&
        !sql.includes('snap.address,');
      if (isCount) {
        return Promise.resolve([{ total_count: String(totalCount) }]);
      }
      return Promise.resolve(
        rows.map((row) => ({ total_count: String(totalCount), ...row })),
      );
    });

    return {
      service: new LeaderboardService({ query } as never),
      snapshotRepository: { query },
    };
  };

  const findCall = (
    query: jest.Mock,
    matcher: (sql: string) => boolean,
  ): [string, unknown[]] => {
    const call = query.mock.calls.find(([sql]) => matcher(sql as string));
    if (!call) {
      throw new Error('No matching query call found');
    }
    return [call[0] as string, call[1] as unknown[]];
  };

  const isRowsQuery = (sql: string) => sql.includes('snap.address,');
  const isFallbackCountQuery = (sql: string) =>
    sql.includes('SELECT COUNT(*)::int AS total_count') &&
    !sql.includes('snap.address,');

  it('reads leaderboard snapshots in a single query carrying the inline total', async () => {
    const { service, snapshotRepository } = createService(
      [
        {
          address: 'ak_test',
          chain_name: null,
          aum_usd: '10',
          pnl_usd: '2',
          roi_pct: '20',
          mdd_pct: '5',
          buy_count: '3',
          sell_count: '1',
          created_tokens_count: '0',
          owned_trends_count: '2',
          portfolio_value_usd_sparkline: [[1, 10]],
          active_buy_count: null,
          active_sell_count: null,
        },
      ],
      7,
    );

    const result = await service.getLeaders({
      window: '7d',
      sortBy: 'pnl',
      sortDir: 'DESC',
      page: 2,
      limit: 10,
    });

    expect(snapshotRepository.query).toHaveBeenCalledTimes(1);

    const [rowsSql, rowsParams] = findCall(
      snapshotRepository.query,
      isRowsQuery,
    );
    expect(rowsSql).not.toContain('active_accounts');
    expect(rowsSql).toContain('(COUNT(*) OVER())::int AS total_count');
    expect(rowsSql).toContain('ORDER BY snap.pnl_usd DESC, snap.address ASC');
    expect(rowsParams).toEqual(['7d', 1, 10, 10]);

    expect(result.totalCandidates).toBe(7);
    expect(result.window).toBe('7d');
    expect(result.sortBy).toBe('pnl');
    expect(result.sortDir).toBe('DESC');
    expect(result.timeFilter).toBeUndefined();
    expect(result.items[0]).toMatchObject({
      address: 'ak_test',
      aum_usd: 10,
      pnl_usd: 2,
      buy_count: 3,
      sell_count: 1,
    });
    expect(result.items[0].active_period).toBeUndefined();
  });

  it('reports total = 0 with no fallback query when the first page is empty', async () => {
    const { service, snapshotRepository } = createService([], 0);

    const result = await service.getLeaders({
      window: '7d',
      sortBy: 'pnl',
      page: 1,
      limit: 10,
    });

    expect(result.items).toEqual([]);
    expect(result.totalCandidates).toBe(0);
    expect(snapshotRepository.query).toHaveBeenCalledTimes(1);
  });

  it('falls back to a COUNT query only when paginating past the end', async () => {
    const { service, snapshotRepository } = createService([], 7);

    const result = await service.getLeaders({
      window: '7d',
      sortBy: 'pnl',
      page: 99,
      limit: 10,
    });

    expect(result.items).toEqual([]);
    expect(result.totalCandidates).toBe(7);
    expect(snapshotRepository.query).toHaveBeenCalledTimes(2);

    const [, rowsParams] = findCall(snapshotRepository.query, isRowsQuery);
    expect(rowsParams).toEqual(['7d', 1, 10, 980]);

    const [countSql, countParams] = findCall(
      snapshotRepository.query,
      isFallbackCountQuery,
    );
    expect(countSql).toContain('SELECT COUNT(*)::int AS total_count');
    expect(countParams).toEqual(['7d', 1]);
  });

  it('defaults sortDir to ASC for sortBy=mdd', async () => {
    const { service, snapshotRepository } = createService([], 0);

    const result = await service.getLeaders({ window: '7d', sortBy: 'mdd' });

    expect(result.sortDir).toBe('ASC');
    const [rowsSql] = findCall(snapshotRepository.query, isRowsQuery);
    expect(rowsSql).toContain('ORDER BY snap.mdd_pct ASC, snap.address ASC');
  });

  it('joins recent activity and emits active_period when a time filter is supplied', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T12:00:00.000Z'));
    const { service, snapshotRepository } = createService(
      [
        {
          address: 'ak_test',
          chain_name: 'alice',
          aum_usd: '100',
          pnl_usd: '5',
          roi_pct: '7',
          mdd_pct: '3',
          buy_count: '50',
          sell_count: '40',
          created_tokens_count: '0',
          owned_trends_count: '0',
          portfolio_value_usd_sparkline: null,
          active_buy_count: '4',
          active_sell_count: '2',
        },
      ],
      1,
    );

    const result = await service.getLeaders({
      window: '30d',
      sortBy: 'aum',
      timePeriod: 2,
      timeUnit: 'hours',
    });

    expect(snapshotRepository.query).toHaveBeenCalledTimes(1);

    const [rowsSql, rowsParams] = findCall(
      snapshotRepository.query,
      isRowsQuery,
    );
    expect(rowsSql).toContain('WITH active_accounts AS');
    expect(rowsSql).toContain("t.tx_type IN ('buy', 'sell')");
    expect(rowsSql).toContain('INNER JOIN active_accounts active');
    expect(rowsSql).toContain('AND EXISTS');
    expect(rowsSql).toContain('AS active_buy_count');
    expect(rowsSql).toContain('(COUNT(*) OVER())::int AS total_count');
    expect(rowsParams).toEqual([
      '30d',
      1,
      new Date('2026-04-28T10:00:00.000Z'),
      new Date('2026-04-28T12:00:00.000Z'),
      18,
      0,
    ]);

    expect(result.timeFilter).toEqual({
      value: 2,
      unit: 'hours',
      start: new Date('2026-04-28T10:00:00.000Z'),
      end: new Date('2026-04-28T12:00:00.000Z'),
    });
    expect(result.items[0].buy_count).toBe(50);
    expect(result.items[0].sell_count).toBe(40);
    expect(result.items[0].active_period).toEqual({
      buy_count: 4,
      sell_count: 2,
    });
  });

  it('accepts the 168-hour upper bound', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T12:00:00.000Z'));
    const { service } = createService([], 0);

    const result = await service.getLeaders({
      window: '7d',
      sortBy: 'pnl',
      timePeriod: 168,
      timeUnit: 'hours',
    });

    expect(result.timeFilter?.start).toEqual(
      new Date('2026-04-21T12:00:00.000Z'),
    );
    expect(result.timeFilter?.end).toEqual(
      new Date('2026-04-28T12:00:00.000Z'),
    );
  });

  it('accepts the 10080-minute upper bound', async () => {
    const { service } = createService([], 0);

    await expect(
      service.getLeaders({
        window: '7d',
        sortBy: 'pnl',
        timePeriod: 10080,
        timeUnit: 'minutes',
      }),
    ).resolves.toBeTruthy();
  });

  it.each([
    [{ timePeriod: 30 }, 'timePeriod and timeUnit must be provided together'],
    [
      { timeUnit: 'hours' as const },
      'timePeriod and timeUnit must be provided together',
    ],
    [
      { timePeriod: 0, timeUnit: 'hours' as const },
      'timePeriod must be a positive integer',
    ],
    [
      { timePeriod: 1.5, timeUnit: 'hours' as const },
      'timePeriod must be a positive integer',
    ],
    [
      { timePeriod: 169, timeUnit: 'hours' as const },
      'timePeriod cannot exceed 7 days',
    ],
    [
      { timePeriod: 10081, timeUnit: 'minutes' as const },
      'timePeriod cannot exceed 7 days',
    ],
    [
      { timePeriod: 1, timeUnit: 'days' as unknown as 'minutes' },
      'timeUnit must be one of: minutes, hours',
    ],
  ])('rejects invalid time filters: %o', async (timeParams, message) => {
    const { service, snapshotRepository } = createService();

    await expect(
      service.getLeaders({
        window: '7d',
        sortBy: 'pnl',
        ...timeParams,
      }),
    ).rejects.toThrow(new BadRequestException(message));
    expect(snapshotRepository.query).not.toHaveBeenCalled();
  });

  it('defends against an unexpected sortBy value reaching the service', async () => {
    const { service, snapshotRepository } = createService();

    await expect(
      service.getLeaders({
        window: '7d',
        sortBy: 'volume' as never,
      }),
    ).rejects.toThrow(
      new BadRequestException('sortBy must be one of: pnl, roi, mdd, aum'),
    );
    expect(snapshotRepository.query).not.toHaveBeenCalled();
  });

  it('defends against an unexpected sortDir value reaching the service', async () => {
    const { service, snapshotRepository } = createService();

    await expect(
      service.getLeaders({
        window: '7d',
        sortBy: 'pnl',
        sortDir: 'sideways' as never,
      }),
    ).rejects.toThrow(
      new BadRequestException('sortDir must be one of: ASC, DESC'),
    );
    expect(snapshotRepository.query).not.toHaveBeenCalled();
  });
});

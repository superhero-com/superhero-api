import { BadRequestException } from '@nestjs/common';
import { batchTimestampToAeHeight } from '@/utils/getBlochHeight';
import { LeaderboardService } from './leaderboard.service';

jest.mock('@/utils/getBlochHeight', () => ({
  batchTimestampToAeHeight: jest.fn(),
}));

describe('LeaderboardService', () => {
  const batchTimestampToAeHeightMock = jest.mocked(batchTimestampToAeHeight);

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  type MockRow = Record<string, unknown>;

  const pnlResult = (totalCurrentValueUsd: number) =>
    ({
      totalCurrentValueUsd,
    }) as never;

  const createService = (options?: {
    snapshotRows?: MockRow[];
    totalCount?: number | string;
    activeRows?: MockRow[];
    accounts?: MockRow[];
    pnlByAddress?: Record<string, number[]>;
  }) => {
    const rows = options?.snapshotRows ?? [];
    const totalCount = options?.totalCount ?? 0;
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
    const transactionQuery = jest
      .fn()
      .mockResolvedValue(options?.activeRows ?? []);
    const find = jest.fn().mockResolvedValue(options?.accounts ?? []);
    const calculateTokenPnlsBatch = jest.fn(
      (address: string, heights: number[]) => {
        const values = options?.pnlByAddress?.[address] ?? [];
        return Promise.resolve(
          new Map(
            heights.map((height, index) => [
              height,
              pnlResult(values[index] ?? 0),
            ]),
          ),
        );
      },
    );

    return {
      service: new LeaderboardService(
        { query } as never,
        { query: transactionQuery } as never,
        { find } as never,
        { calculateTokenPnlsBatch } as never,
        {} as never,
      ),
      snapshotRepository: { query },
      transactionsRepository: { query: transactionQuery },
      accountRepository: { find },
      bclPnlService: { calculateTokenPnlsBatch },
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
    const { service, snapshotRepository } = createService({
      snapshotRows: [
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
      totalCount: 7,
    });

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
    const { service, snapshotRepository } = createService();

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
    const { service, snapshotRepository } = createService({ totalCount: 7 });

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
    const { service, snapshotRepository } = createService();

    const result = await service.getLeaders({ window: '7d', sortBy: 'mdd' });

    expect(result.sortDir).toBe('ASC');
    const [rowsSql] = findCall(snapshotRepository.query, isRowsQuery);
    expect(rowsSql).toContain('ORDER BY snap.mdd_pct ASC, snap.address ASC');
  });

  it('ranks active traders by selected-period performance when startDate and endDate are supplied', async () => {
    batchTimestampToAeHeightMock.mockImplementation((timestamps: number[]) =>
      Promise.resolve(
        new Map(timestamps.map((timestamp, index) => [timestamp, index + 100])),
      ),
    );

    const {
      service,
      snapshotRepository,
      transactionsRepository,
      bclPnlService,
    } = createService({
      activeRows: [
        {
          address: 'ak_a',
          buy_count: '4',
          sell_count: '2',
          volume_usd: '200',
        },
        {
          address: 'ak_b',
          buy_count: '1',
          sell_count: '3',
          volume_usd: '150',
        },
      ],
      accounts: [
        { address: 'ak_a', chain_name: 'alice' },
        { address: 'ak_b', chain_name: 'bob' },
      ],
      pnlByAddress: {
        ak_a: [100, 102, 104, 106, 108, 109, 109, 110],
        ak_b: [10, 12, 15, 18, 20, 25, 28, 30],
      },
    });

    const result = await service.getLeaders({
      window: '30d',
      sortBy: 'pnl',
      startDate: '2026-04-28T10:00:00.000Z',
      endDate: '2026-04-28T12:00:00.000Z',
    });

    expect(snapshotRepository.query).not.toHaveBeenCalled();
    expect(transactionsRepository.query).toHaveBeenCalledTimes(1);

    const [activeSql, activeParams] =
      transactionsRepository.query.mock.calls[0];
    expect(activeSql).toContain("t.tx_type IN ('buy', 'sell')");
    expect(activeSql).toContain('GROUP BY t.address');
    expect(activeSql).toContain('ORDER BY volume_usd DESC, t.address ASC');
    expect(activeParams).toEqual([
      new Date('2026-04-28T10:00:00.000Z'),
      new Date('2026-04-28T12:00:00.000Z'),
      100,
    ]);
    expect(batchTimestampToAeHeightMock).toHaveBeenCalledTimes(1);
    expect(bclPnlService.calculateTokenPnlsBatch).toHaveBeenCalledTimes(2);

    expect(result.timeFilter).toEqual({
      start: new Date('2026-04-28T10:00:00.000Z'),
      end: new Date('2026-04-28T12:00:00.000Z'),
    });
    expect(result.totalCandidates).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      address: 'ak_b',
      chain_name: 'bob',
      aum_usd: 30,
      pnl_usd: 20,
      roi_pct: 200,
      buy_count: 1,
      sell_count: 3,
      volume_usd: 150,
    });
    expect(result.items[0].active_period).toBeUndefined();
    expect(result.items[1]).toMatchObject({
      address: 'ak_a',
      aum_usd: 110,
      pnl_usd: 10,
      roi_pct: 10,
      buy_count: 4,
      sell_count: 2,
      volume_usd: 200,
    });
  });

  it('sorts and paginates computed event metrics after applying min AUM', async () => {
    batchTimestampToAeHeightMock.mockImplementation((timestamps: number[]) =>
      Promise.resolve(
        new Map(timestamps.map((timestamp, index) => [timestamp, index + 100])),
      ),
    );
    const { service } = createService({
      activeRows: [
        {
          address: 'ak_low',
          buy_count: '1',
          sell_count: '0',
          volume_usd: '10',
        },
        {
          address: 'ak_top',
          buy_count: '1',
          sell_count: '0',
          volume_usd: '10',
        },
        {
          address: 'ak_second',
          buy_count: '1',
          sell_count: '0',
          volume_usd: '10',
        },
      ],
      pnlByAddress: {
        ak_low: [0, 0, 0, 0, 0, 0, 0, 0],
        ak_top: [10, 20, 30, 40, 50, 60, 70, 80],
        ak_second: [50, 51, 52, 53, 54, 55, 56, 60],
      },
    });

    const result = await service.getLeaders({
      sortBy: 'roi',
      page: 2,
      limit: 1,
      minAumUsd: 1,
      startDate: '2026-04-28T11:30:00.000Z',
      endDate: '2026-04-28T12:00:00.000Z',
    });

    expect(result.totalCandidates).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].address).toBe('ak_second');
  });

  it('accepts a 14-day selected period', async () => {
    const { service } = createService();

    const result = await service.getLeaders({
      window: '7d',
      sortBy: 'pnl',
      startDate: '2026-04-14T12:00:00.000Z',
      endDate: '2026-04-28T12:00:00.000Z',
    });

    expect(result.timeFilter?.start).toEqual(
      new Date('2026-04-14T12:00:00.000Z'),
    );
    expect(result.timeFilter?.end).toEqual(
      new Date('2026-04-28T12:00:00.000Z'),
    );
  });

  it.each([
    [
      { startDate: '2026-04-28T10:00:00.000Z' },
      'startDate and endDate must be provided together',
    ],
    [
      { endDate: '2026-04-28T12:00:00.000Z' },
      'startDate and endDate must be provided together',
    ],
    [
      { startDate: 'not-a-date', endDate: '2026-04-28T12:00:00.000Z' },
      'startDate and endDate must be valid ISO 8601 timestamps',
    ],
    [
      {
        startDate: '2026-04-28T12:00:00.000Z',
        endDate: '2026-04-28T10:00:00.000Z',
      },
      'endDate must be after startDate',
    ],
    [
      {
        startDate: '2026-04-14T11:59:59.999Z',
        endDate: '2026-04-28T12:00:00.000Z',
      },
      'Selected period cannot exceed 14 days',
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

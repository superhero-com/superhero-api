import {
  LeaderboardSnapshotService,
  PNL_CACHE_MIN_DEPTH,
  PNL_CACHE_TTL_MS,
} from './leaderboard-snapshot.service';
import { LEADERBOARD_SNAPSHOT_MAX_CANDIDATES } from './leaderboard.types';
import { BclPnlService, TokenPnlResult } from './bcl-pnl.service';
import { timestampToAeHeight } from '@/utils/getBlochHeight';

const DAY_MS = 24 * 3600 * 1000;
const BLOCK_MS = 3 * 60 * 1000;

// Approximates timestampToAeHeight: points older than 48h snap to the end of their day.
jest.mock('@/utils/getBlochHeight', () => ({
  timestampToAeHeight: jest.fn(async (ts: number) => {
    const snapped =
      Date.now() - ts > 2 * 24 * 3600 * 1000
        ? new Date(ts).setUTCHours(23, 59, 59, 999)
        : ts;
    return Math.floor(Math.min(snapped, Date.now()) / (3 * 60 * 1000));
  }),
}));

const heightAt = (ms: number) => Math.floor(ms / BLOCK_MS);

// Distinct per account and per height, so a point served for the wrong
// account or height changes the written rows.
const pnlAt = (address: string, height: number): TokenPnlResult => {
  const account = Number(address.slice('ak_'.length)) + 1;
  return {
    pnls: {},
    totalCostBasisAe: 10 * account,
    totalCostBasisUsd: 20 * account,
    totalCurrentValueAe: (height % 1000) * account,
    totalCurrentValueUsd: (height % 1000) * account,
    totalGainAe: (height % 100) * account,
    totalGainUsd: (height % 50) * account,
  };
};

type Rows = unknown[] | ((params: any) => unknown[]);

// Collects the where() parameters, so a fake can answer like the filtered query.
function queryBuilder(rows: Rows) {
  const params: Record<string, any> = {};
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['select', 'addSelect', 'groupBy', 'orderBy', 'limit']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  for (const method of ['where', 'andWhere']) {
    qb[method] = jest.fn((_condition: string, values?: object) => {
      Object.assign(params, values);
      return qb;
    });
  }
  qb.getRawMany = jest.fn(async () =>
    typeof rows === 'function' ? rows(params) : rows,
  );
  return qb;
}

type CountRow = { address: string; buy_count: string; sell_count: string };

interface ServiceOptions {
  pnl?: (address: string, height: number) => TokenPnlResult;
  accounts?: Array<{ address: string; chain_name: string | null }>;
  counts?: CountRow[] | ((params: { start: Date; end: Date }) => CountRow[]);
  created?: Array<{ creator_address: string; created_count: string }>;
  owned?: Array<{ address: string; owned_count: string }>;
  bclPnl?: BclPnlService;
}

function createService(candidateCount: number, options: ServiceOptions = {}) {
  const candidatesOf = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      address: `ak_${i}`,
      volume_usd: String(1000 - i),
    }));
  // The first query of a run loads candidates; the rest are per-window counts.
  const armRun = (mock: jest.Mock, count: number) =>
    mock
      .mockImplementationOnce(() => queryBuilder(candidatesOf(count)))
      .mockImplementation(() => queryBuilder(options.counts ?? []));
  const transactionsRepository = {
    createQueryBuilder: armRun(jest.fn(), candidateCount),
  };
  const points: Array<[string, number]> = [];
  const pnlPoint = (address: string, height: number) => {
    points.push([address, height]);
    return (options.pnl ?? pnlAt)(address, height);
  };
  const calculateTokenPnls = jest.fn(async (address: string, height: number) =>
    pnlPoint(address, height),
  );
  let inFlight = 0;
  let peakInFlight = 0;
  const calculateTokenPnlsBatch = jest.fn(
    async (...[address, heights]: [string, number[], boolean?, boolean?]) => {
      peakInFlight = Math.max(peakInFlight, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return new Map(
        heights.map((height) => [height, pnlPoint(address, height)]),
      );
    },
  );
  const written = new Map<string, any[]>();
  const deleted: string[] = [];
  const snapshotRepo = {
    delete: jest.fn(async ({ window }) => {
      deleted.push(window);
    }),
    create: jest.fn((row) => row),
    save: jest.fn(async (rows) => {
      written.set(rows[0].window, rows);
    }),
  };
  const service = new LeaderboardSnapshotService(
    transactionsRepository as any,
    { find: jest.fn().mockResolvedValue(options.accounts ?? []) } as any,
    { createQueryBuilder: () => queryBuilder(options.created ?? []) } as any,
    { createQueryBuilder: () => queryBuilder(options.owned ?? []) } as any,
    {
      manager: {
        transaction: jest.fn(async (work) =>
          work({ getRepository: () => snapshotRepo }),
        ),
      },
    } as any,
    options.bclPnl ?? ({ calculateTokenPnls, calculateTokenPnlsBatch } as any),
    {} as any,
  );
  const pointsFor = (address: string) => points.filter(([a]) => a === address);
  const computedHeights = () => new Set(points.map(([, height]) => height));
  const computedPoints = () => points.length;
  const nextRun = (count = candidateCount) => {
    armRun(transactionsRepository.createQueryBuilder, count);
    points.length = 0;
    calculateTokenPnls.mockClear();
    calculateTokenPnlsBatch.mockClear();
  };
  return {
    service,
    candidateQuery: () =>
      transactionsRepository.createQueryBuilder.mock.results[0].value,
    calculateTokenPnls,
    calculateTokenPnlsBatch,
    peakInFlight: () => peakInFlight,
    points,
    pointsFor,
    computedHeights,
    computedPoints,
    nextRun,
    written,
    deleted,
  };
}

describe('LeaderboardSnapshotService', () => {
  // Noon UTC, so no sampled point crosses midnight between runs 10 minutes apart.
  const noon = Date.UTC(2026, 9, 12, 12, 0, 0);

  beforeEach(() => {
    jest.useFakeTimers({ now: noon });
    jest.mocked(timestampToAeHeight).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pins LEADERBOARD_SNAPSHOT_MAX_CANDIDATES to its expected ceiling', () => {
    // The read path's inline `COUNT(*) OVER()` is O(≤N) only because each
    // leaderboard window is materialized at most this many rows. Bumping this
    // value means revisiting the read service's docs and (possibly) switching
    // to cursor pagination — see leaderboard.service.ts comments.
    expect(LEADERBOARD_SNAPSHOT_MAX_CANDIDATES).toBe(100);
  });

  it('caps the candidate query at LEADERBOARD_SNAPSHOT_MAX_CANDIDATES', async () => {
    const ctx = createService(1);

    await ctx.service.refreshAllWindows();

    expect(ctx.candidateQuery().limit).toHaveBeenCalledWith(
      LEADERBOARD_SNAPSHOT_MAX_CANDIDATES,
    );
  });

  it('computes every sampled point once and writes all windows', async () => {
    const ctx = createService(45);

    await ctx.service.refreshAllWindows();

    const points = ctx.points.map(
      ([address, height]) => `${address}:${height}`,
    );
    expect(new Set(points).size).toBe(points.length);
    const sampled = await Promise.all(
      jest.mocked(timestampToAeHeight).mock.results.map((r) => r.value),
    );
    expect(ctx.computedHeights()).toEqual(new Set(sampled));
    expect(ctx.computedPoints()).toBe(45 * ctx.computedHeights().size);
    expect([...ctx.written.keys()].sort()).toEqual(['30d', '7d', 'all']);
    expect(ctx.written.get('7d')).toHaveLength(45);
  });

  it("builds each account's window metrics from its own sampled points", async () => {
    const ctx = createService(3);

    await ctx.service.refreshAllWindows();

    for (const row of ctx.written.get('all')!) {
      const newest = pnlAt(row.address, heightAt(noon));
      const spark = row.portfolio_value_usd_sparkline;
      expect(spark).toHaveLength(24);
      expect(spark[23]).toEqual([noon, newest.totalCurrentValueUsd]);
      expect(row.aum_usd).toBe(newest.totalCurrentValueUsd);
      // "all" reports all-time gain over cost basis from the newest point.
      expect(row.pnl_usd).toBe(newest.totalGainUsd);
      expect(row.roi_pct).toBe(
        (newest.totalGainUsd / newest.totalCostBasisUsd) * 100,
      );
    }

    for (const row of ctx.written.get('7d')!) {
      const spark = row.portfolio_value_usd_sparkline;
      expect(spark).toHaveLength(8);
      expect(row.pnl_usd).toBe(spark[7][1] - spark[0][1]);
    }
  });

  it('derives drawdown, window PnL and activity for a candidate', async () => {
    // 7d samples one point per day: 100 ×6, then 50, then 75.
    const valueAt = (height: number) =>
      height === heightAt(noon)
        ? 75
        : height === heightAt(noon - DAY_MS)
          ? 50
          : 100;
    const ctx = createService(1, {
      pnl: (address, height) => ({
        ...pnlAt(address, height),
        totalCurrentValueUsd: valueAt(height),
      }),
      accounts: [{ address: 'ak_0', chain_name: 'nikita.chain' }],
      counts: [{ address: 'ak_0', buy_count: '3', sell_count: '2' }],
      created: [{ creator_address: 'ak_0', created_count: '2' }],
      owned: [{ address: 'ak_0', owned_count: '4' }],
    });

    await ctx.service.refreshAllWindows();

    const [week] = ctx.written.get('7d')!;
    expect(week).toMatchObject({
      address: 'ak_0',
      chain_name: 'nikita.chain',
      aum_usd: 75,
      pnl_usd: -25,
      roi_pct: -25,
      mdd_pct: 50,
      buy_count: 3,
      sell_count: 2,
      created_tokens_count: 2,
      owned_trends_count: 4,
    });
  });

  it('floors a negative portfolio value at zero', async () => {
    const ctx = createService(1, {
      pnl: (address, height) => ({
        ...pnlAt(address, height),
        totalCurrentValueUsd: -5,
      }),
    });

    await ctx.service.refreshAllWindows();

    const [week] = ctx.written.get('7d')!;
    expect(week.aum_usd).toBe(0);
    expect(
      week.portfolio_value_usd_sparkline.map(([, value]) => value),
    ).toEqual(Array(8).fill(0));
  });

  it('counts trades within each window', async () => {
    const ctx = createService(1, {
      // Stands in for the date filter: one buy per day since the window start.
      counts: ({ start, end }) => [
        {
          address: 'ak_0',
          buy_count: String(
            Math.round((end.getTime() - start.getTime()) / DAY_MS),
          ),
          sell_count: '0',
        },
      ],
    });

    await ctx.service.refreshAllWindows();

    expect(ctx.written.get('7d')![0].buy_count).toBe(7);
    expect(ctx.written.get('30d')![0].buy_count).toBe(30);
    expect(ctx.written.get('all')![0].buy_count).toBe(365);
  });

  it('reuses settled points on the next run and recomputes only the moving ones', async () => {
    const ctx = createService(45);
    await ctx.service.refreshAllWindows();

    const now = noon + 10 * 60 * 1000;
    jest.setSystemTime(now);
    ctx.nextRun();
    await ctx.service.refreshAllWindows();

    // Points within 48h of the tip aren't snapped, so they move every run.
    expect([...ctx.computedHeights()].sort()).toEqual(
      [
        heightAt(now - 2 * DAY_MS),
        heightAt(now - DAY_MS),
        heightAt(now),
      ].sort(),
    );
    expect(ctx.computedPoints()).toBe(45 * 3);
  });

  it('writes the same rows whether points came from the cache or not', async () => {
    const cached = createService(5);
    await cached.service.refreshAllWindows();
    jest.setSystemTime(noon + 10 * 60 * 1000);
    cached.nextRun();
    await cached.service.refreshAllWindows();

    const fresh = createService(5);
    await fresh.service.refreshAllWindows();

    expect(cached.computedPoints()).toBeLessThan(fresh.computedPoints());
    expect([...cached.written]).toEqual([...fresh.written]);
  });

  it('never serves points within PNL_CACHE_MIN_DEPTH of the tip from the cache', async () => {
    const ctx = createService(3);
    await ctx.service.refreshAllWindows();
    const heights = [...ctx.computedHeights()];
    const tip = Math.max(...heights);

    ctx.nextRun();
    await ctx.service.refreshAllWindows();

    expect([...ctx.computedHeights()].sort()).toEqual(
      heights.filter((h) => h > tip - PNL_CACHE_MIN_DEPTH).sort(),
    );
  });

  it('recomputes settled points once they are older than the cache TTL', async () => {
    const ctx = createService(3);
    await ctx.service.refreshAllWindows();

    jest.setSystemTime(noon + PNL_CACHE_TTL_MS + 60 * 1000);
    ctx.nextRun();
    await ctx.service.refreshAllWindows();

    // A cold run at the same moment computes every sampled point.
    const fresh = createService(3);
    await fresh.service.refreshAllWindows();
    expect(ctx.computedPoints()).toBe(fresh.computedPoints());
  });

  it('forgets the points of an account that leaves the candidate list', async () => {
    const ctx = createService(2);
    await ctx.service.refreshAllWindows();
    const coldPoints = ctx.pointsFor('ak_1').length;

    ctx.nextRun(1);
    await ctx.service.refreshAllWindows();
    ctx.nextRun(2);
    await ctx.service.refreshAllWindows();

    // ak_0 stayed, so only its tip point is recomputed; ak_1 starts cold.
    expect(ctx.pointsFor('ak_0')).toHaveLength(1);
    expect(ctx.pointsFor('ak_1')).toHaveLength(coldPoints);
  });

  it("computes an account's missing heights in one totals-only batch", async () => {
    const ctx = createService(3);

    await ctx.service.refreshAllWindows();

    expect(ctx.calculateTokenPnls).not.toHaveBeenCalled();
    expect(ctx.calculateTokenPnlsBatch).toHaveBeenCalledTimes(3);
    for (const [, heights, includeTokenPnls, consistentSnapshot] of ctx
      .calculateTokenPnlsBatch.mock.calls) {
      expect(new Set(heights)).toEqual(ctx.computedHeights());
      expect(includeTokenPnls).toBe(false);
      expect(consistentSnapshot).toBe(true);
    }
  });

  it('batches only the heights the cache could not serve', async () => {
    const ctx = createService(2);
    await ctx.service.refreshAllWindows();

    const now = noon + 10 * 60 * 1000;
    jest.setSystemTime(now);
    ctx.nextRun();
    await ctx.service.refreshAllWindows();

    expect(ctx.calculateTokenPnlsBatch).toHaveBeenCalledTimes(2);
    for (const [, heights] of ctx.calculateTokenPnlsBatch.mock.calls) {
      expect([...heights].sort()).toEqual(
        [
          heightAt(now - 2 * DAY_MS),
          heightAt(now - DAY_MS),
          heightAt(now),
        ].sort(),
      );
    }
  });

  it('uses the single-height query when only one height is missing', async () => {
    const ctx = createService(3);
    await ctx.service.refreshAllWindows();

    ctx.nextRun();
    await ctx.service.refreshAllWindows();

    expect(ctx.calculateTokenPnlsBatch).not.toHaveBeenCalled();
    expect(ctx.calculateTokenPnls).toHaveBeenCalledTimes(3);
  });

  it('runs at most eight batches at once, as each takes one connection', async () => {
    const ctx = createService(20);

    await ctx.service.refreshAllWindows();

    expect(ctx.calculateTokenPnlsBatch).toHaveBeenCalledTimes(20);
    expect(ctx.peakInFlight()).toBe(8);
  });

  it('runs eight single-height computations at once as well', async () => {
    const ctx = createService(20);
    let running = 0;
    let peak = 0;
    ctx.calculateTokenPnls.mockImplementation(async (address, height) => {
      peak = Math.max(peak, ++running);
      await Promise.resolve();
      running--;
      return pnlAt(address, height);
    });

    await (ctx.service as any).resolvePnlTotals(
      Array.from({ length: 20 }, (_, i) => `ak_${i}`),
      [1000],
    );

    expect(ctx.calculateTokenPnlsBatch).not.toHaveBeenCalled();
    expect(ctx.calculateTokenPnls).toHaveBeenCalledTimes(20);
    expect(peak).toBe(8);
  });

  it('holds one connection per account when every batch fails', async () => {
    let running = 0;
    let peak = 0;
    const query = jest.fn(async () => {
      await Promise.resolve();
      throw new Error('could not resize shared memory segment');
    });
    const transaction = jest.fn(
      async (_isolation: string, work: (manager: unknown) => unknown) => {
        peak = Math.max(peak, ++running);
        try {
          await Promise.resolve();
          return await work({ query });
        } finally {
          running--;
        }
      },
    );
    const ctx = createService(LEADERBOARD_SNAPSHOT_MAX_CANDIDATES, {
      bclPnl: new BclPnlService({ manager: { transaction } } as any),
    });

    await ctx.service.refreshAllWindows();

    expect(transaction).toHaveBeenCalledTimes(
      LEADERBOARD_SNAPSHOT_MAX_CANDIDATES,
    );
    expect(peak).toBe(8);
    expect(running).toBe(0);
    expect(ctx.written.size).toBe(0);
  });

  describe('with LEADERBOARD_PNL_BATCH_ENABLED=false', () => {
    beforeEach(() => {
      process.env.LEADERBOARD_PNL_BATCH_ENABLED = 'false';
    });

    afterEach(() => {
      delete process.env.LEADERBOARD_PNL_BATCH_ENABLED;
    });

    it('runs one query per point and writes the rows the batch writes', async () => {
      const single = createService(5);
      await single.service.refreshAllWindows();
      delete process.env.LEADERBOARD_PNL_BATCH_ENABLED;
      const batched = createService(5);
      await batched.service.refreshAllWindows();

      expect(single.calculateTokenPnlsBatch).not.toHaveBeenCalled();
      expect(single.calculateTokenPnls).toHaveBeenCalledTimes(
        single.computedPoints(),
      );
      expect(batched.calculateTokenPnls).not.toHaveBeenCalled();
      expect([...single.written]).toEqual([...batched.written]);
    });

    it('stops at the first failing point of an account', async () => {
      const ctx = createService(3, {
        pnl: (address, height) => {
          if (address === 'ak_1') throw new Error('statement timeout');
          return pnlAt(address, height);
        },
      });

      await ctx.service.refreshAllWindows();

      expect(
        ctx.calculateTokenPnls.mock.calls.filter(([a]) => a === 'ak_1'),
      ).toHaveLength(1);
      expect(ctx.written.get('7d')!.map((r) => r.address)).toEqual([
        'ak_0',
        'ak_2',
      ]);
    });
  });

  it('drops a failing candidate after a single attempt and writes the others', async () => {
    const ctx = createService(20, {
      pnl: (address, height) => {
        if (address === 'ak_2') throw new Error('statement timeout');
        return pnlAt(address, height);
      },
    });

    await ctx.service.refreshAllWindows();

    expect(ctx.written.size).toBe(3);
    for (const rows of ctx.written.values()) {
      expect(rows).toHaveLength(19);
      expect(rows.map((r) => r.address)).not.toContain('ak_2');
    }
    expect(
      ctx.calculateTokenPnlsBatch.mock.calls.filter(([a]) => a === 'ak_2'),
    ).toHaveLength(1);
  });

  it('keeps the previous snapshot when every candidate fails', async () => {
    const ctx = createService(3, {
      pnl: () => {
        throw new Error('connection refused');
      },
    });

    await ctx.service.refreshAllWindows();

    expect(ctx.deleted).toEqual([]);
    expect(ctx.written.size).toBe(0);
  });

  it('clears every window when there are no candidates', async () => {
    const ctx = createService(0);

    await ctx.service.refreshAllWindows();

    expect(ctx.computedPoints()).toBe(0);
    expect(ctx.deleted.sort()).toEqual(['30d', '7d', 'all']);
    expect(ctx.written.size).toBe(0);
  });
});

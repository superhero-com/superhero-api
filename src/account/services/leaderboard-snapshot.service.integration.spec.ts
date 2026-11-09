import 'dotenv/config';
import { EntityManager } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { AccountLeaderboardSnapshot } from '../entities/account-leaderboard-snapshot.entity';
import { BclPnlService } from './bcl-pnl.service';
import { LeaderboardSnapshotService } from './leaderboard-snapshot.service';

/**
 * Runs the whole refresh on real Postgres with batched and per-point PnL and
 * compares the rows each writes. Skipped automatically when no DB host is set.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const DAY_MS = 24 * 3600 * 1000;
const BLOCKS_PER_DAY = 480;
const TIP = 1_000_000;

// Whole days only, so runs moments apart sample the same heights.
jest.mock('@/utils/getBlochHeight', () => ({
  timestampToAeHeight: jest.fn(
    async (ts: number) =>
      1_000_000 - Math.round((Date.now() - ts) / (24 * 3600 * 1000)) * 480,
  ),
}));

interface Trade {
  sale: string;
  type: 'buy' | 'sell' | 'create_community';
  ageBlocks: number;
  address: string;
  volume: string;
  amount: string;
  price: string;
  microBlock: number;
}

function generatedTrades(): Trade[] {
  let seed = 11;
  const random = () =>
    (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  return Array.from({ length: 600 }, () => ({
    sale: pick(['ct_0', 'ct_1', 'ct_2', 'ct_3', 'ct_4', 'ct_5']),
    type: pick(['buy', 'buy', 'sell', 'create_community'] as const),
    // Mostly in the sampled year, some inside the moving last two days.
    ageBlocks:
      random() < 0.2
        ? Math.floor(random() * 2 * BLOCKS_PER_DAY)
        : Math.floor(random() * 300 * BLOCKS_PER_DAY),
    address: pick(['ak_a', 'ak_a', 'ak_b', 'ak_c', 'ak_d']),
    volume: (random() * 100).toFixed(6),
    amount: (random() * 50).toFixed(6),
    price: random() < 0.08 ? 'NaN' : (random() * 5).toFixed(6),
    microBlock: Math.floor(random() * 3),
  }));
}

const queryBuilderStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb;
};

const DOUBLE_COLUMNS = ['aum_usd', 'pnl_usd', 'roi_pct', 'mdd_pct'] as const;

d('LeaderboardSnapshotService (integration)', () => {
  let db: IsolatedDb;
  let bclPnl: BclPnlService;
  let inserted = 0;

  const insert = async (trades: Trade[]) => {
    for (const t of trades) {
      await db.dataSource.query(
        `INSERT INTO transactions
           (tx_hash, sale_address, tx_type, block_height, address, volume,
            amount, unit_price, buy_price, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $8, $9)`,
        [
          `th_${inserted++}`,
          t.sale,
          t.type,
          TIP - t.ageBlocks,
          t.address,
          t.volume,
          JSON.stringify({ ae: t.amount, usd: t.amount }),
          JSON.stringify({ ae: t.price, usd: t.price }),
          new Date(
            Date.now() -
              (t.ageBlocks / BLOCKS_PER_DAY) * DAY_MS +
              t.microBlock * 3_000,
          ),
        ],
      );
    }
    await db.dataSource.query('ANALYZE transactions');
  };

  const newService = () =>
    new LeaderboardSnapshotService(
      db.dataSource.getRepository(Transaction),
      { find: jest.fn().mockResolvedValue([]) } as any,
      { createQueryBuilder: queryBuilderStub } as any,
      { createQueryBuilder: queryBuilderStub } as any,
      db.dataSource.getRepository(AccountLeaderboardSnapshot),
      bclPnl,
      db.dataSource,
    );

  const writtenRows = async () =>
    db.dataSource.getRepository(AccountLeaderboardSnapshot).find({
      order: { window: 'ASC', address: 'ASC' },
    });

  // A refresh that fails keeps the old rows, which would match any comparison.
  const refresh = async (service: LeaderboardSnapshotService) => {
    await db.dataSource.query('DELETE FROM account_leaderboard_snapshots');
    await service.refreshAllWindows();
    return writtenRows();
  };

  const refreshPerPoint = async () => {
    process.env.LEADERBOARD_PNL_BATCH_ENABLED = 'false';
    try {
      return await refresh(newService());
    } finally {
      delete process.env.LEADERBOARD_PNL_BATCH_ENABLED;
    }
  };

  // Totals are summed in a different token order, so only the last bits may
  // differ.
  const expectSameRows = (
    actual: AccountLeaderboardSnapshot[],
    expected: AccountLeaderboardSnapshot[],
  ) => {
    expect(actual.map((r) => [r.window, r.address])).toEqual(
      expected.map((r) => [r.window, r.address]),
    );
    actual.forEach((row, i) => {
      const other = expected[i];
      for (const column of DOUBLE_COLUMNS) {
        expect(row[column]).toBeCloseTo(other[column], 6);
      }
      expect(row.buy_count).toBe(other.buy_count);
      expect(row.sell_count).toBe(other.sell_count);
      const spark = row.portfolio_value_usd_sparkline!;
      const otherSpark = other.portfolio_value_usd_sparkline!;
      expect(spark).toHaveLength(otherSpark.length);
      spark.forEach(([, value], j) => {
        expect(value).toBeCloseTo(otherSpark[j][1], 6);
      });
    });
  };

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Transaction, AccountLeaderboardSnapshot],
      migrations: [],
    });
    await db.dataSource.synchronize();
    await insert(generatedTrades());

    // Tied trades come back in index order, so both modes must use the index
    // scans prod runs; a table this small would otherwise get seq scans. Set on
    // the database and reconnected, so that every pooled connection has them.
    await db.dataSource.query(
      `ALTER DATABASE "${db.name}" SET enable_seqscan = off`,
    );
    await db.dataSource.query(
      `ALTER DATABASE "${db.name}" SET enable_bitmapscan = off`,
    );
    await db.dataSource.destroy();
    await db.dataSource.initialize();
    bclPnl = new BclPnlService(db.dataSource.getRepository(Transaction));
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes the same rows as one query per point on a cold run', async () => {
    const perPoint = await refreshPerPoint();

    const batch = jest.spyOn(bclPnl, 'calculateTokenPnlsBatch');
    const batched = await refresh(newService());

    expect(batch).toHaveBeenCalledTimes(4);
    expect(batched).toHaveLength(12);
    expect(batched.some((row) => row.aum_usd > 0)).toBe(true);
    expectSameRows(batched, perPoint);
  });

  it('keeps cached points and picks up a new trade at the tip on a warm run', async () => {
    const service = newService();
    const before = await refresh(service);
    await insert([
      {
        sale: 'ct_0',
        type: 'buy',
        ageBlocks: 1,
        address: 'ak_a',
        volume: '40',
        amount: '40',
        price: '7.5',
        microBlock: 0,
      },
    ]);

    const single = jest.spyOn(bclPnl, 'calculateTokenPnls');
    const batch = jest.spyOn(bclPnl, 'calculateTokenPnlsBatch');
    const warm = await refresh(service);

    // Only the tip is within PNL_CACHE_MIN_DEPTH, so one point per account.
    expect(single).toHaveBeenCalledTimes(4);
    expect(batch).not.toHaveBeenCalled();
    expect(
      warm.find((r) => r.window === '7d' && r.address === 'ak_a')!.aum_usd,
    ).not.toBeCloseTo(
      before.find((r) => r.window === '7d' && r.address === 'ak_a')!.aum_usd,
      6,
    );

    jest.restoreAllMocks();
    expectSameRows(warm, await refreshPerPoint());
  });

  describe('with a consistent snapshot', () => {
    const ADDRESS = 'ak_snapshot';
    const SALE = 'ct_snapshot';
    const trade = (ageBlocks: number, price: string): Trade => ({
      sale: SALE,
      type: 'buy',
      ageBlocks,
      address: ADDRESS,
      volume: '10',
      amount: '1',
      price,
      microBlock: 0,
    });

    afterEach(() =>
      db.dataSource.query('DELETE FROM transactions WHERE sale_address = $1', [
        SALE,
      ]),
    );

    it('does not see a trade that lands between the two queries', async () => {
      await insert([trade(20, '2')]);
      const query = EntityManager.prototype.query;
      let landed = false;
      jest
        .spyOn(EntityManager.prototype, 'query')
        .mockImplementation(async function (
          this: EntityManager,
          sql: string,
          params?: any[],
        ) {
          const rows = await query.call(this, sql, params);
          if (!landed && sql.includes('per_block')) {
            landed = true;
            await insert([trade(10, '9')]);
          }
          return rows;
        });

      const result = await bclPnl.calculateTokenPnlsBatch(
        ADDRESS,
        [TIP - 15, TIP],
        true,
        true,
      );

      expect(landed).toBe(true);
      const atTip = result.get(TIP)!.pnls[SALE];
      expect(atTip.current_unit_price.ae).toBe(2);
      expect(atTip.current_value.ae).toBe(20);
    });

    it('returns its connection when a query fails', async () => {
      const pool = (db.dataSource.driver as any).master;
      const inUse = pool.totalCount - pool.idleCount;
      jest
        .spyOn(EntityManager.prototype, 'query')
        .mockRejectedValueOnce(new Error('statement timeout'));

      await expect(
        bclPnl.calculateTokenPnlsBatch(ADDRESS, [TIP - 15, TIP], true, true),
      ).rejects.toThrow('statement timeout');

      expect(pool.totalCount - pool.idleCount).toBe(inUse);
    });
  });
});

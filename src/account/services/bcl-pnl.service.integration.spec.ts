import 'dotenv/config';
import { QueryRunner } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { BclPnlService, TokenPnlResult } from './bcl-pnl.service';

/**
 * Checks the cumulative calculateTokenPnlsBatch against calculateTokenPnls,
 * which answers one height per query, on real Postgres. Skipped automatically
 * when no DB host is set.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const ME = 'ak_me';
const OTHER = 'ak_other';
const BLOCK_MS = 180_000;
const START = Date.UTC(2025, 0, 1);

type Price = Record<string, string | null>;
interface Trade {
  sale: string;
  type: 'buy' | 'sell' | 'create_community';
  block: number;
  address: string;
  volume: string;
  amount: Price;
  buyPrice: Price;
  // Trades in one micro block share created_at (it is the micro block time).
  microBlock: number;
}

const trade = (
  sale: string,
  type: Trade['type'],
  block: number,
  address: string,
  volume: string,
  amount: Price,
  buyPrice: Price,
  microBlock = 0,
): Trade => ({
  sale,
  type,
  block,
  address,
  volume,
  amount,
  buyPrice,
  microBlock,
});

const p = (ae: string | null, usd: string | null): Price => ({ ae, usd });

const handPicked: Trade[] = [
  trade('ct_ties', 'buy', 100, ME, '10', p('10', '20'), p('1', '2')),
  trade('ct_ties', 'buy', 110, OTHER, '1', p('1', '2'), p('1.1', '2.2')),
  // Three trades in one micro block, each with a different price.
  trade('ct_ties', 'buy', 130, OTHER, '1', p('1', '2'), p('1.31', '2.62')),
  trade('ct_ties', 'buy', 130, OTHER, '1', p('1', '2'), p('1.32', '2.64')),
  trade('ct_ties', 'sell', 130, OTHER, '1', p('1', '2'), p('1.3', '2.6')),
  trade('ct_ties', 'sell', 140, ME, '4', p('6', '12'), p('NaN', '2.8')),
  trade('ct_ties', 'buy', 150, OTHER, '1', p('1', '2'), p('1.5', 'NaN')),
  trade('ct_ties', 'buy', 160, OTHER, '1', p('1', '2'), {}),
  trade('ct_ties', 'buy', 165, OTHER, '1', p('1', '2'), p('null', '')),
  trade('ct_ties', 'buy', 170, OTHER, '1', p('1', '2'), p(null, null)),
  trade('ct_closed', 'buy', 105, ME, '5', p('5', '10'), p('1', '2')),
  trade('ct_closed', 'sell', 145, ME, '5', p('7', '14'), p('1.4', '2.8')),
  trade('ct_no_price', 'buy', 120, ME, '3', p('3', 'NaN'), p('NaN', 'NaN')),
  trade('ct_block', 'create_community', 90, ME, '2', p('2', '4'), p('1', '2')),
  trade('ct_block', 'buy', 125, ME, '1', p('1.2', '2.4'), p('1.2', '2.4'), 1),
  trade('ct_block', 'buy', 125, ME, '1', p('1.3', '2.6'), p('1.3', '2.6'), 2),
  trade('ct_foreign', 'buy', 115, OTHER, '1', p('1', '2'), p('1', '2')),
];

// Deterministic bulk trades with frequent same-micro-block ties.
function generatedTrades(): Trade[] {
  let seed = 7;
  const random = () =>
    (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const number = (max: number) => (random() * max).toFixed(6);
  const price = (): Price => {
    const r = random();
    if (r < 0.06) return { ae: 'NaN', usd: 'NaN' };
    if (r < 0.1) return { ae: number(5), usd: 'NaN' };
    if (r < 0.14) return { ae: 'NaN', usd: number(9) };
    if (r < 0.17) return {};
    return { ae: number(5), usd: number(9) };
  };
  return Array.from({ length: 400 }, () =>
    trade(
      pick(['ct_g0', 'ct_g1', 'ct_g2', 'ct_g3', 'ct_g4']),
      pick(['buy', 'buy', 'sell', 'create_community'] as const),
      100 + Math.floor(random() * 300),
      pick([ME, ME, 'ak_other', 'ak_other2']),
      number(100),
      random() < 0.05
        ? { ae: 'NaN', usd: number(90) }
        : { ae: number(50), usd: number(90) },
      price(),
      Math.floor(random() * 3),
    ),
  );
}

const TOTAL_KEYS = [
  'totalCostBasisAe',
  'totalCostBasisUsd',
  'totalCurrentValueAe',
  'totalCurrentValueUsd',
  'totalGainAe',
  'totalGainUsd',
] as const;

// Totals are summed in a different token order, so only the last bits may
// differ; per-token values must match exactly.
function expectSameResult(actual: TokenPnlResult, expected: TokenPnlResult) {
  expect(actual.pnls).toEqual(expected.pnls);
  for (const key of TOTAL_KEYS) {
    expect(actual[key]).toBeCloseTo(expected[key], 6);
  }
}

d('BclPnlService cumulative batch (integration)', () => {
  let db: IsolatedDb;
  let runner: QueryRunner;
  let service: BclPnlService;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Transaction],
      migrations: [],
    });
    await db.dataSource.synchronize();

    const trades = [...handPicked, ...generatedTrades()];
    for (const [i, t] of trades.entries()) {
      await db.dataSource.query(
        `INSERT INTO transactions
           (tx_hash, sale_address, tx_type, block_height, address, volume,
            amount, unit_price, buy_price, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $8, $9)`,
        [
          `th_${i}`,
          t.sale,
          t.type,
          t.block,
          t.address,
          t.volume,
          JSON.stringify(t.amount),
          JSON.stringify(t.buyPrice),
          new Date(START + t.block * BLOCK_MS + t.microBlock * 3_000),
        ],
      );
    }
    await db.dataSource.query('ANALYZE transactions');

    // Tied trades come back in index order, so both sides must use the index
    // scans prod runs; a table this small would otherwise get seq scans.
    runner = db.dataSource.createQueryRunner();
    await runner.connect();
    await runner.query('SET enable_seqscan = off');
    await runner.query('SET enable_bitmapscan = off');
    service = new BclPnlService(runner.manager.getRepository(Transaction));
  }, 60_000);

  afterAll(async () => {
    await runner?.release();
    if (db) await db.drop();
  }, 60_000);

  const heightSets: Record<string, number[]> = {
    'every 10 blocks': Array.from({ length: 34 }, (_, i) => 90 + i * 10),
    'trade blocks and the ones after': [100, 101, 125, 126, 130, 131, 145, 146],
    'unsorted with duplicates': [300, 125, 300, 101, 260],
    'height 0 and below the first trade': [0, 50, 95, 200],
    'one height above every trade': [401],
    'two heights far apart': [1, 1000],
  };

  for (const address of [ME, OTHER, 'ak_nobody']) {
    for (const [label, heights] of Object.entries(heightSets)) {
      it(`matches calculateTokenPnls for ${address}: ${label}`, async () => {
        const batch = await service.calculateTokenPnlsBatch(address, heights);
        const totalsOnly = await service.calculateTokenPnlsBatch(
          address,
          heights,
          false,
        );

        const uniqueHeights = [...new Set(heights)];
        expect([...batch.keys()]).toEqual(uniqueHeights);
        for (const height of uniqueHeights) {
          const expected = await service.calculateTokenPnls(address, height);
          expectSameResult(batch.get(height)!, expected);
          expect(totalsOnly.get(height)).toEqual({
            ...batch.get(height)!,
            pnls: {},
          });
        }
      });
    }
  }

  it('prices a micro-block tie the way the single-height lookup does', async () => {
    const batch = await service.calculateTokenPnlsBatch(ME, [100, 131]);
    const expected = await service.calculateTokenPnls(ME, 131);

    expect(batch.get(131)!.pnls.ct_ties.current_unit_price).toEqual(
      expected.pnls.ct_ties.current_unit_price,
    );
  });

  it('values ct_closed from its trades: bought 5 for 5 AE, sold at 145 for 7 AE', async () => {
    const batch = await service.calculateTokenPnlsBatch(ME, [145, 146]);

    // 145: the sell is not counted yet, but its 1.4 price already applies.
    expect(batch.get(145)!.pnls.ct_closed).toEqual({
      current_unit_price: { ae: 1.4, usd: 2.8 },
      percentage: 40,
      invested: { ae: 5, usd: 10 },
      current_value: { ae: 7, usd: 14 },
      gain: { ae: 2, usd: 4 },
    });
    expect(batch.get(146)!.pnls.ct_closed).toEqual({
      current_unit_price: { ae: 1.4, usd: 2.8 },
      percentage: 40,
      invested: { ae: 5, usd: 10 },
      current_value: { ae: 0, usd: 0 },
      gain: { ae: 2, usd: 4 },
    });
  });
});

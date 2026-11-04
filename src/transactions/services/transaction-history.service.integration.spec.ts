import 'dotenv/config';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '../entities/transaction.entity';
import { TransactionHistoryService } from './transaction-history.service';

/**
 * Runs the paginated candle SQL against real Postgres, which is the only way to
 * check the bound price key and paging. Skipped automatically when no DB host
 * is set.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('TransactionHistoryService.getPaginatedHistoricalData (integration)', () => {
  let db: IsolatedDb;
  let service: TransactionHistoryService;
  const token = Object.assign(new Token(), {
    sale_address: 'ct_sale',
    symbol: 'TKN',
  });

  // Raw timestamps keep the hourly buckets independent of the test machine's
  // time zone.
  const insert = (
    hash: string,
    saleAddress: string,
    createdAt: string,
    ae: string,
    usd: string,
    volume: number,
  ) =>
    db.dataSource.query(
      `INSERT INTO transactions
         (tx_hash, sale_address, tx_type, block_height, address, amount,
          unit_price, buy_price, market_cap, volume, created_at)
       VALUES ($1, $2, 'buy', 1, 'ak_buyer', '{}', '{}', $3, $4, $5, $6)`,
      [
        hash,
        saleAddress,
        JSON.stringify({ ae, usd }),
        JSON.stringify({ ae: `${ae}00`, usd: `${usd}00` }),
        volume,
        createdAt,
      ],
    );

  const fetchHistory = (overrides: Record<string, unknown> = {}) =>
    service.getPaginatedHistoricalData({
      token,
      interval: 3600,
      page: 1,
      limit: 100,
      convertTo: 'ae',
      ...overrides,
    } as any);

  const quotes = (candles: Awaited<ReturnType<typeof fetchHistory>>) =>
    candles.map(({ quote }) => ({
      convertedTo: quote.convertedTo,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.close,
      volume: quote.volume,
      market_cap: quote.market_cap.toString(),
    }));

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Transaction],
      migrations: [],
    });
    await db.dataSource.synchronize();
    service = new TransactionHistoryService(
      db.dataSource.getRepository(Transaction),
      {} as any,
      db.dataSource,
    );

    await insert('th_1', 'ct_sale', '2026-01-01 00:10:00', '1', '7', 5);
    await insert('th_2', 'ct_sale', '2026-01-01 00:50:00', '3', '9', 7);
    await insert('th_3', 'ct_sale', '2026-01-01 01:20:00', '2', '8', 1);
    await insert('th_nan', 'ct_sale', '2026-01-01 01:30:00', 'NaN', 'NaN', 4);
    await insert('th_other', 'ct_other', '2026-01-01 00:20:00', '5', '5', 9);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  it('builds hourly candles from the requested currency key', async () => {
    expect(quotes(await fetchHistory())).toEqual([
      {
        convertedTo: 'ae',
        open: '1',
        high: '3',
        low: '1',
        close: '3',
        volume: 12,
        market_cap: '300',
      },
      {
        convertedTo: 'ae',
        open: '3',
        high: '2',
        low: '2',
        close: '2',
        volume: 1,
        market_cap: '200',
      },
    ]);

    expect(
      quotes(await fetchHistory({ convertTo: 'USD' })).map(
        ({ convertedTo, low, high, market_cap }) => ({
          convertedTo,
          low,
          high,
          market_cap,
        }),
      ),
    ).toEqual([
      { convertedTo: 'usd', low: '7', high: '9', market_cap: '900' },
      { convertedTo: 'usd', low: '8', high: '8', market_cap: '800' },
    ]);
  });

  it('closes each candle one interval after it opens', async () => {
    const candles = await fetchHistory({ interval: 1800 });

    expect(candles).toHaveLength(3);
    for (const { timeOpen, timeClose } of candles) {
      expect(timeClose.getTime() - timeOpen.getTime()).toBe(1800 * 1000);
    }
  });

  it('pages from the newest interval', async () => {
    const [latest] = quotes(await fetchHistory({ limit: 1 }));
    const [previous] = quotes(await fetchHistory({ page: 2, limit: 1 }));

    expect(latest.close).toBe('2');
    expect(previous.close).toBe('3');
    expect(await fetchHistory({ page: 3, limit: 1 })).toEqual([]);
  });
});

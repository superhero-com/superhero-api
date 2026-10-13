import 'dotenv/config';
import { DataSource, QueryRunner } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { TokenPerformanceViewSinglePass1718900000027 } from '@/migrations/1718900000027-TokenPerformanceViewSinglePass';
import { TokenPerformanceTable1718900000036 } from '@/migrations/1718900000036-TokenPerformanceTable';
import { DexSyncService } from '@/dex/services/dex-sync.service';
import { TokenPerformance } from '../entities/token-performance.entity';
import { RefreshTokenPerformanceService } from './refresh-token-performance.service';

const d = process.env.DB_HOST ? describe : describe.skip;

// Only the columns the old view and the refresh read.
const SCHEMA_SQL = [
  `CREATE TABLE "token" ("sale_address" character varying PRIMARY KEY)`,
  `CREATE TABLE "transactions" ("tx_hash" character varying PRIMARY KEY, "sale_address" character varying NOT NULL, "volume" numeric NOT NULL DEFAULT 0, "buy_price" json NOT NULL, "created_at" timestamp NOT NULL)`,
];

const price = (ae: string) => JSON.stringify({ ae, usd: `${ae}0` });
const NAN = JSON.stringify({ ae: 'NaN' });

const TOKENS = ['ct_a', 'ct_b', 'ct_c', 'ct_no_trades'];

// [sale_address, buy_price, age, volume]. Ages stay hours away from the window
// edges, so the view and the refresh agree although they read NOW() apart.
const TRADES: [string, string, string, string][] = [
  ['ct_a', price('1.5'), '2 hours', '10'],
  ['ct_a', price('3'), '3 hours', '5'],
  ['ct_a', NAN, '1 hour', '7'],
  ['ct_a', '{}', '4 hours', '1'],
  ['ct_a', price('2'), '3 days', '4'],
  ['ct_a', price('5'), '10 days', '2'],
  ['ct_a', price('0.5'), '60 days', '9'],
  // Equal prices: the earliest trade must win both high and low.
  ['ct_b', price('2'), '100 days', '1'],
  ['ct_b', price('2'), '90 days', '1'],
  ['ct_b', price('1'), '95 days', '1'],
  ['ct_b', price('1'), '80 days', '1'],
  ['ct_c', NAN, '5 days', '3'],
  ['ct_not_a_token', price('9'), '2 days', '1'],
];

const snapshot = (ds: DataSource, relation: string) =>
  ds.query(
    `SELECT sale_address, past_24h::text, past_7d::text, past_30d::text, all_time::text
     FROM ${relation} ORDER BY sale_address`,
  );

// The cases share one database and build on each other in order.
d('token_performance: migration 1718900000036 and refresh', () => {
  let db: IsolatedDb;
  let queryRunner: QueryRunner;
  let service: RefreshTokenPerformanceService;
  let viewRows: any[];

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      migrations: [],
      entities: [TokenPerformance],
      seedSql: SCHEMA_SQL,
    });
    const ds = db.dataSource;
    for (const token of TOKENS) {
      await ds.query('INSERT INTO token VALUES ($1)', [token]);
    }
    for (const [i, [token, buyPrice, age, volume]] of TRADES.entries()) {
      await ds.query(
        'INSERT INTO transactions VALUES ($1, $2, $3, $4::json, now() - $5::interval)',
        [`th_${i}`, token, volume, buyPrice, age],
      );
    }

    queryRunner = ds.createQueryRunner();
    await new TokenPerformanceViewSinglePass1718900000027().up(queryRunner);
    viewRows = await snapshot(ds, 'token_performance_view');
    await new TokenPerformanceTable1718900000036().up(queryRunner);
    service = new RefreshTokenPerformanceService(ds);
  }, 60_000);

  afterAll(async () => {
    await queryRunner?.release();
    await db?.drop();
  });

  it('seeds the table from the view and drops the view', async () => {
    expect(viewRows.map((row) => row.sale_address)).toEqual([
      'ct_a',
      'ct_b',
      'ct_c',
    ]);
    await expect(snapshot(db.dataSource, 'token_performance')).resolves.toEqual(
      viewRows,
    );
    const [{ view }] = await db.dataSource.query(
      `SELECT to_regclass('token_performance_view') AS view`,
    );
    expect(view).toBeNull();
  });

  it('creates the table exactly as the entity declares it', async () => {
    const pending = await db.dataSource.driver.createSchemaBuilder().log();
    expect(pending.upQueries).toEqual([]);
  });

  it('recomputes the same rows as the view', async () => {
    await db.dataSource.query('TRUNCATE token_performance');

    await expect(service.refreshPerformance()).resolves.toEqual({
      changed: 3,
      removed: 0,
    });
    await expect(snapshot(db.dataSource, 'token_performance')).resolves.toEqual(
      viewRows,
    );
  });

  it('leaves rows untouched when no trades changed', async () => {
    await expect(service.refreshPerformance()).resolves.toEqual({
      changed: 0,
      removed: 0,
    });
    // ON CONFLICT stamps xmax on every row it locks, even one it doesn't update.
    const [{ touched }] = await db.dataSource.query(
      `SELECT count(*)::int AS touched FROM token_performance WHERE xmax::text <> '0'`,
    );
    expect(touched).toBe(0);
  });

  it('rewrites only the token that traded', async () => {
    await db.dataSource.query(
      `INSERT INTO transactions VALUES ('th_new', 'ct_b', 1, $1::json, now() - interval '1 minute')`,
      [price('7')],
    );

    await expect(service.refreshPerformance()).resolves.toEqual({
      changed: 1,
      removed: 0,
    });
    const [{ all_time }] = await db.dataSource.query(
      `SELECT all_time FROM token_performance WHERE sale_address = 'ct_b'`,
    );
    expect(all_time.high).toEqual({ ae: '7', usd: '70' });
  });

  it('removes a token whose trades were rolled back', async () => {
    await db.dataSource.query(
      `DELETE FROM transactions WHERE sale_address = 'ct_c'`,
    );

    await expect(service.refreshPerformance()).resolves.toEqual({
      changed: 0,
      removed: 1,
    });
  });

  it('is not blocked by the DEX price-sync lock', async () => {
    const dexKey = DexSyncService['PRICE_SYNC_LOCK_KEY'];
    const dexSession = db.dataSource.createQueryRunner();
    await dexSession.query('SELECT pg_advisory_lock($1)', [dexKey]);
    try {
      await expect(service.refreshPerformance()).resolves.not.toBeNull();
    } finally {
      await dexSession.query('SELECT pg_advisory_unlock($1)', [dexKey]);
      await dexSession.release();
    }
  });

  it('down() restores the materialized view', async () => {
    await new TokenPerformanceTable1718900000036().down(queryRunner);

    const [state] = await db.dataSource.query(`
      SELECT to_regclass('token_performance') AS "table",
             to_regclass('"IDX_TRANSACTION_SALE_ADDRESS_PRICE_AE"') AS "index",
             (SELECT count(*)::int FROM token_performance_view) AS "rows"
    `);
    expect(state).toEqual({ table: null, index: null, rows: 2 });
  });
});

import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';

/**
 * Checks that DB_STATEMENT_TIMEOUT_MS reaches Postgres through the pg pool and
 * that the opt-out works. Skipped automatically when no DB host is set.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;
// query_canceled; the message text follows the server's locale.
const QUERY_CANCELED = { code: '57014' };

d('DB_STATEMENT_TIMEOUT_MS (integration)', () => {
  const ORIGINAL = process.env.DB_STATEMENT_TIMEOUT_MS;
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = '200';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { APP_DATABASE_CONFIG } = require('./database');
    dataSource = new DataSource({
      ...(APP_DATABASE_CONFIG as DataSourceOptions),
      entities: [],
      synchronize: false,
      // Two connections, so a leaked one would stall the next query.
      extra: { ...APP_DATABASE_CONFIG.extra, max: 2, min: 1 },
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
    if (ORIGINAL === undefined) {
      delete process.env.DB_STATEMENT_TIMEOUT_MS;
    } else {
      process.env.DB_STATEMENT_TIMEOUT_MS = ORIGINAL;
    }
  });

  it('cancels a statement that runs past the limit', async () => {
    await expect(dataSource.query('SELECT pg_sleep(1)')).rejects.toMatchObject(
      QUERY_CANCELED,
    );
  });

  it('returns the connection to the pool after each cancelled statement', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(
        dataSource.query('SELECT pg_sleep(1)'),
      ).rejects.toMatchObject(QUERY_CANCELED);
    }

    await expect(dataSource.query('SELECT 1 AS ok')).resolves.toEqual([
      { ok: 1 },
    ]);
  });

  it('restores the pool limit when a dedicated runner resets its opt-out', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query('SET statement_timeout = 0');
      await runner.query('SELECT pg_sleep(0.4)');
      await runner.query('RESET statement_timeout');

      await expect(runner.query('SHOW statement_timeout')).resolves.toEqual([
        { statement_timeout: '200ms' },
      ]);
    } finally {
      await runner.release();
    }
  });

  it('lets a transaction opt out with SET LOCAL without changing the pool', async () => {
    await dataSource.transaction(async (manager) => {
      await manager.query('SET LOCAL statement_timeout = 0');
      await manager.query('SELECT pg_sleep(0.4)');
    });

    for (let i = 0; i < 2; i++) {
      await expect(
        dataSource.query('SELECT pg_sleep(1)'),
      ).rejects.toMatchObject(QUERY_CANCELED);
    }
  });
});

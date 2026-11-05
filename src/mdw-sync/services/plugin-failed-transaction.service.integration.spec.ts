import 'dotenv/config';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import { PluginFailedTransactionRetry1718900000041 } from '@/migrations/1718900000041-PluginFailedTransactionRetry';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { PluginFailedTransaction } from '../entities/plugin-failed-transaction.entity';
import { SyncState } from '../entities/sync-state.entity';
import { Tx } from '../entities/tx.entity';
import {
  FAILED_TX_RETRY_LOCK_KEY,
  MAX_RETRY_ATTEMPTS,
  PluginFailedTransactionService,
} from './plugin-failed-transaction.service';

const d = process.env.DB_HOST ? describe : describe.skip;

interface StubPlugin {
  name: string;
  version: number;
  retryParkedFailures?: boolean;
  processBatch: jest.Mock;
}

d('PluginFailedTransactionService (integration)', () => {
  // Default reorgDepth is 100 and the margin 5, so only rows below height 895
  // are retried.
  const TIP_HEIGHT = 1000;
  let db: IsolatedDb;
  let plugin: StubPlugin;
  let plugins: StubPlugin[];
  let service: PluginFailedTransactionService;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [PluginFailedTransaction, Tx, SyncState],
      migrations: [
        BaseSchema1718900000000,
        PluginFailedTransactionRetry1718900000041,
      ],
    });
    await db.dataSource.runMigrations();
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.dataSource.query('DELETE FROM plugin_failed_transaction');
    await db.dataSource.query('DELETE FROM txs');
    await db.dataSource.query('DELETE FROM sync_state');
    await db.dataSource.query(
      `INSERT INTO sync_state (id, last_synced_height, last_synced_hash, tip_height)
       VALUES ('global', 0, '', $1)`,
      [TIP_HEIGHT],
    );
    plugin = {
      name: 'bcl',
      version: 1,
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };
    plugins = [plugin];
    service = new PluginFailedTransactionService(
      db.dataSource.getRepository(PluginFailedTransaction),
      db.dataSource.getRepository(Tx),
      db.dataSource.getRepository(SyncState),
      db.dataSource,
      { getPlugins: () => plugins } as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any,
    );
  });

  async function tx(hash: string, height: number, microTime = 0) {
    await db.dataSource.query(
      `INSERT INTO txs (hash, block_hash, block_height, micro_index, micro_time, signatures, type, raw)
       VALUES ($1, 'mh_x', $2, 0, $3, '[]', 'ContractCallTx', '{}')`,
      [hash, height, microTime],
    );
  }

  const retriedHashes = (call: number): string[] =>
    plugin.processBatch.mock.calls[call][0].map((t: Tx) => t.hash);

  async function parked(
    hash: string,
    fields: {
      plugin?: string;
      version?: number;
      attempts?: number;
      nextRetryAt?: Date | null;
    } = {},
  ) {
    await db.dataSource.query(
      `INSERT INTO plugin_failed_transaction (plugin_name, tx_hash, error_message, version, attempts, next_retry_at)
       VALUES ($1, $2, 'timeout exceeded when trying to connect', $3, $4, $5)`,
      [
        fields.plugin ?? 'bcl',
        hash,
        fields.version ?? 1,
        fields.attempts ?? 0,
        fields.nextRetryAt ?? null,
      ],
    );
  }

  const rows = (): Promise<
    Array<{
      tx_hash: string;
      attempts: number;
      next_retry_at: Date | null;
      error_message: string;
      version: number;
    }>
  > =>
    db.dataSource.query(
      `SELECT tx_hash, attempts, next_retry_at, error_message, version
       FROM plugin_failed_transaction ORDER BY tx_hash`,
    );

  it('adds the retry columns with the entity definitions', async () => {
    const columns = await db.dataSource.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'plugin_failed_transaction'
         AND column_name IN ('attempts', 'next_retry_at')
       ORDER BY column_name`,
    );
    expect(columns).toEqual([
      {
        column_name: 'attempts',
        data_type: 'integer',
        is_nullable: 'NO',
        column_default: '0',
      },
      {
        column_name: 'next_retry_at',
        data_type: 'timestamp without time zone',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);

    const diff = await db.dataSource.driver.createSchemaBuilder().log();
    expect(
      diff.upQueries
        .map((q) => q.query)
        .filter((sql) => sql.includes('plugin_failed_transaction')),
    ).toEqual([]);
  });

  it('deletes rows that now succeed and backs off the ones still failing', async () => {
    await tx('th_ok', 500);
    await tx('th_bad', 600);
    await parked('th_ok');
    await parked('th_bad');
    plugin.processBatch.mockImplementation(async (txs: Tx[]) => ({
      failed: txs
        .filter((t) => t.hash === 'th_bad')
        .map((t) => ({ tx: t, error: new Error('still broken') })),
    }));
    const now = new Date();

    await service.retryDue(now);

    expect(plugin.processBatch).toHaveBeenCalledTimes(1);
    const [retried, direction] = plugin.processBatch.mock.calls[0];
    expect(retried.map((t: Tx) => t.hash).sort()).toEqual(['th_bad', 'th_ok']);
    expect(direction).toBe('backward');

    const [left, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(left).toMatchObject({
      tx_hash: 'th_bad',
      attempts: 1,
      error_message: 'still broken',
    });
    expect(left.next_retry_at!.getTime() - now.getTime()).toBe(10 * 60_000);
  });

  it('leaves the validation window and the margin below it alone', async () => {
    await tx('th_window', TIP_HEIGHT - 100);
    await tx('th_margin', TIP_HEIGHT - 105);
    await tx('th_below', TIP_HEIGHT - 106);
    await parked('th_window');
    await parked('th_margin');
    await parked('th_below');

    await service.retryDue(new Date());

    expect(plugin.processBatch).toHaveBeenCalledTimes(1);
    expect(retriedHashes(0)).toEqual(['th_below']);
    expect(await rows()).toMatchObject([
      { tx_hash: 'th_margin', attempts: 0 },
      { tx_hash: 'th_window', attempts: 0 },
    ]);
  });

  it('retries in chain order, not in the order rows were parked', async () => {
    await tx('th_a', 600);
    await tx('th_b', 500, 2);
    await tx('th_c', 500, 1);
    await parked('th_a');
    await parked('th_b');
    await parked('th_c');

    await service.retryDue(new Date());

    expect(retriedHashes(0)).toEqual(['th_c', 'th_b', 'th_a']);
  });

  it('never retries a plugin that opted out, even after a version bump', async () => {
    const links: StubPlugin = {
      name: 'address-links',
      version: 2,
      retryParkedFailures: false,
      processBatch: jest.fn(),
    };
    plugins = [plugin, links];
    await tx('th_link', 500);
    await parked('th_link', { plugin: 'address-links', version: 1 });

    await service.retryDue(new Date());

    expect(links.processBatch).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([
      { tx_hash: 'th_link', attempts: 0, version: 1 },
    ]);
  });

  it('backs off every row when the whole batch throws', async () => {
    await tx('th_a', 500);
    await tx('th_b', 600);
    await parked('th_a');
    await parked('th_b');
    plugin.processBatch.mockRejectedValue(new Error('pool timeout'));

    await service.retryDue(new Date());

    expect(await rows()).toMatchObject([
      { tx_hash: 'th_a', attempts: 1, error_message: 'pool timeout' },
      { tx_hash: 'th_b', attempts: 1, error_message: 'pool timeout' },
    ]);
  });

  it('logs an error for rows that run out of attempts', async () => {
    const error = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation();
    await tx('th_last', 500);
    await tx('th_early', 600);
    await parked('th_last', { attempts: MAX_RETRY_ATTEMPTS - 1 });
    await parked('th_early', { attempts: 1 });
    plugin.processBatch.mockRejectedValue(new Error('still broken'));

    await service.retryDue(new Date());

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain(
      '[bcl] 1 parked transactions are out of retries',
    );
    expect(error.mock.calls[0][0]).toContain('th_last');
    expect(error.mock.calls[0][0]).not.toContain('th_early');
  });

  it('retries at most 1000 rows per run, lowest heights first, and leaves the rest for the next', async () => {
    await db.dataSource.query(
      `UPDATE sync_state SET tip_height = 5000 WHERE id = 'global'`,
    );
    // Heights run against hash order, so th_0001 is the highest block.
    await db.dataSource.query(
      `INSERT INTO txs (hash, block_hash, block_height, micro_index, micro_time, signatures, type, raw)
       SELECT 'th_' || lpad(i::text, 4, '0'), 'mh_x', 1051 - i, 0, 0, '[]', 'ContractCallTx', '{}'
       FROM generate_series(1, 1050) AS i`,
    );
    await db.dataSource.query(
      `INSERT INTO plugin_failed_transaction (plugin_name, tx_hash, error_message, version)
       SELECT 'bcl', 'th_' || lpad(i::text, 4, '0'), 'timeout', 1
       FROM generate_series(1, 1050) AS i`,
    );
    plugin.processBatch.mockRejectedValue(new Error('still broken'));
    const now = new Date();

    await service.retryDue(now);

    expect(plugin.processBatch).toHaveBeenCalledTimes(10);
    const untouched = (await rows()).filter((row) => row.attempts === 0);
    expect(untouched.map((row) => row.tx_hash)).toEqual(
      Array.from(
        { length: 50 },
        (_, i) => `th_${String(i + 1).padStart(4, '0')}`,
      ),
    );

    await service.retryDue(now);

    expect(plugin.processBatch).toHaveBeenCalledTimes(11);
    expect(retriedHashes(10)).toHaveLength(50);
    expect((await rows()).every((row) => row.attempts === 1)).toBe(true);
  }, 60_000);

  it('skips rows that are not due yet or out of attempts', async () => {
    const now = new Date();
    await tx('th_later', 500);
    await tx('th_dead', 500);
    await parked('th_later', {
      attempts: 2,
      nextRetryAt: new Date(now.getTime() + 60 * 60_000),
    });
    await parked('th_dead', { attempts: MAX_RETRY_ATTEMPTS });

    await service.retryDue(now);

    expect(plugin.processBatch).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([
      { tx_hash: 'th_dead', attempts: MAX_RETRY_ATTEMPTS },
      { tx_hash: 'th_later', attempts: 2 },
    ]);
  });

  it('retries a row that falls due just after the run starts', async () => {
    // The previous run backed it off from a `now` read a little later in its
    // tick than this run's.
    const now = new Date();
    await tx('th_due', 500);
    await parked('th_due', {
      attempts: 1,
      nextRetryAt: new Date(now.getTime() + 30_000),
    });

    await service.retryDue(now);

    expect(plugin.processBatch).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([]);
  });

  it('gives exhausted rows new attempts after a plugin version bump', async () => {
    plugin.version = 2;
    await tx('th_dead', 500);
    await parked('th_dead', { attempts: MAX_RETRY_ATTEMPTS, version: 1 });

    await service.retryDue(new Date());

    expect(plugin.processBatch).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([]);
  });

  it('drops rows whose tx was removed from txs', async () => {
    await parked('th_orphan');

    await service.retryDue(new Date());

    expect(plugin.processBatch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it('clears the rows of reorged-out txs for every plugin and keeps the rest', async () => {
    await parked('th_gone');
    await parked('th_gone', { plugin: 'dex' });
    await parked('th_keep');

    await service.clearFailuresForTxs(['th_gone']);

    expect((await rows()).map((row) => row.tx_hash)).toEqual(['th_keep']);
  });

  it('only retries rows of the plugin being run', async () => {
    await tx('th_dex', 500);
    await parked('th_dex', { plugin: 'dex' });

    await service.retryDue(new Date());

    expect(plugin.processBatch).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ tx_hash: 'th_dex', attempts: 0 }]);
  });

  it('does nothing while another session holds the retry lock', async () => {
    await tx('th_ok', 500);
    await parked('th_ok');
    const other = db.dataSource.createQueryRunner();
    await other.connect();
    try {
      await other.query('SELECT pg_advisory_lock($1)', [
        FAILED_TX_RETRY_LOCK_KEY,
      ]);

      await service.retryDueFailedTransactions();
      expect(plugin.processBatch).not.toHaveBeenCalled();

      await other.query('SELECT pg_advisory_unlock($1)', [
        FAILED_TX_RETRY_LOCK_KEY,
      ]);
      await service.retryDueFailedTransactions();
      expect(plugin.processBatch).toHaveBeenCalledTimes(1);
      expect(await rows()).toEqual([]);
    } finally {
      await other.release();
    }
  });
});

import { PostLanguageBackfillService } from './post-language-backfill.service';

/**
 * Fake DataSource: the advisory lock runs on the query runner, the backfill
 * loop runs on `dataSource.query`. The backfill SELECT returns no rows so the
 * loop exits after one page — enough to assert the guard, the lock lifecycle
 * and the resolved batch size without a real database.
 */
function makeDataSource(locked: boolean) {
  const lockRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked }];
      return [];
    }),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const query = jest.fn(async () => []); // backfill SELECT → empty → loop ends
  const dataSource = {
    createQueryRunner: jest.fn(() => lockRunner),
    query,
  };
  return { dataSource, lockRunner, query };
}

const ENV_KEYS = [
  'POST_LANGUAGE_BACKFILL_DISABLED',
  'POST_LANGUAGE_BACKFILL_BATCH_SIZE',
  'POST_LANGUAGE_BACKFILL_SLEEP_MS',
  'POST_LANGUAGE_BACKFILL_MAX_BATCHES',
  'DISABLE_MDW_SYNC',
];

describe('PostLanguageBackfillService', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('onModuleInit scheduling', () => {
    it('schedules the deferred run when enabled', () => {
      jest.useFakeTimers();
      const { dataSource } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);
      const run = jest
        .spyOn(service, 'runBackfill')
        .mockResolvedValue(undefined);

      service.onModuleInit();
      expect(run).not.toHaveBeenCalled(); // deferred, not on the boot path
      jest.advanceTimersByTime(30_000);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('does not schedule a run when disabled by the kill switch', () => {
      jest.useFakeTimers();
      process.env.POST_LANGUAGE_BACKFILL_DISABLED = 'true';
      const { dataSource } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);
      const run = jest
        .spyOn(service, 'runBackfill')
        .mockResolvedValue(undefined);

      service.onModuleInit();
      jest.advanceTimersByTime(60_000);
      expect(run).not.toHaveBeenCalled();
    });

    it('does not schedule a run when live MDW sync is disabled', () => {
      jest.useFakeTimers();
      process.env.DISABLE_MDW_SYNC = 'true';
      const { dataSource } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);
      const run = jest
        .spyOn(service, 'runBackfill')
        .mockResolvedValue(undefined);

      service.onModuleInit();
      jest.advanceTimersByTime(60_000);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('runBackfill', () => {
    it('acquires the lock, runs the backfill, then unlocks and releases', async () => {
      const { dataSource, lockRunner, query } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);

      await service.runBackfill();

      // Lock acquired, then released.
      expect(lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [expect.any(Number)],
      );
      expect(lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [expect.any(Number)],
      );
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
      // Backfill actually ran (issued its keyset SELECT).
      expect(query).toHaveBeenCalled();
    });

    it('skips the backfill and does not unlock when another instance holds the lock', async () => {
      const { dataSource, lockRunner, query } = makeDataSource(false);
      const service = new PostLanguageBackfillService(dataSource as any);

      await service.runBackfill();

      expect(query).not.toHaveBeenCalled(); // backfill never ran
      const unlockCalls = lockRunner.query.mock.calls.filter(([sql]) =>
        String(sql).includes('pg_advisory_unlock'),
      );
      expect(unlockCalls).toHaveLength(0); // never unlock a lock we don't hold
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
    });

    it('does nothing when disabled', async () => {
      process.env.POST_LANGUAGE_BACKFILL_DISABLED = 'true';
      const { dataSource } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);

      await service.runBackfill();

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('does not overlap a run already in progress', async () => {
      const { dataSource } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);
      (service as any).running = true;

      await service.runBackfill();

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('uses conservative defaults (batch size 500) with no env overrides', async () => {
      const { dataSource, query } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);

      await service.runBackfill();

      // First backfill SELECT pages with [lastId, batchSize].
      expect(query).toHaveBeenCalledWith(expect.any(String), ['', 500]);
    });

    it('honours a valid env batch-size override', async () => {
      process.env.POST_LANGUAGE_BACKFILL_BATCH_SIZE = '100';
      const { dataSource, query } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);

      await service.runBackfill();

      expect(query).toHaveBeenCalledWith(expect.any(String), ['', 100]);
    });

    it('falls back to defaults on an invalid env override instead of crashing', async () => {
      process.env.POST_LANGUAGE_BACKFILL_BATCH_SIZE = 'not-a-number';
      const { dataSource, query } = makeDataSource(true);
      const service = new PostLanguageBackfillService(dataSource as any);

      await expect(service.runBackfill()).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledWith(expect.any(String), ['', 500]);
    });

    it('releases the lock even if the backfill throws', async () => {
      const { dataSource, lockRunner } = makeDataSource(true);
      dataSource.query = jest.fn(async () => {
        throw new Error('db exploded');
      });
      const service = new PostLanguageBackfillService(dataSource as any);

      await expect(service.runBackfill()).resolves.toBeUndefined(); // swallowed
      const unlockCalls = lockRunner.query.mock.calls.filter(([sql]) =>
        String(sql).includes('pg_advisory_unlock'),
      );
      expect(unlockCalls).toHaveLength(1);
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
    });
  });
});

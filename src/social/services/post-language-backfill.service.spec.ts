import { PostLanguageBackfillService } from './post-language-backfill.service';

interface FakeRow {
  id: string;
  content: string | null;
  language: string | null;
}

/**
 * In-memory Postgres stand-in. The advisory lock runs on the query runner; the
 * backfill's keyset SELECT and guarded batch UPDATE run on `dataSource.query`,
 * enforcing the same `language IS NULL` guards Postgres would, so the null-only
 * and resumable behaviour is exercised without a real database.
 */
function makeDataSource(rows: FakeRow[], locked = true) {
  const store = rows.map((r) => ({ ...r }));
  const query = jest.fn(async (sql: string, params: any[]) => {
    if (sql.includes('SELECT id, content FROM posts')) {
      const [lastId, batchSize] = params as [string, number];
      return store
        .filter((r) => r.language === null && r.id > lastId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, batchSize)
        .map((r) => ({ id: r.id, content: r.content }));
    }
    // UPDATE ... RETURNING p.id — params flattened as [id, lang, id, lang, ...]
    const updated: Array<{ id: string }> = [];
    for (let i = 0; i < params.length; i += 2) {
      const id = params[i] as string;
      const language = params[i + 1] as string;
      const row = store.find((r) => r.id === id);
      if (row && row.language === null) {
        row.language = language;
        updated.push({ id });
      }
    }
    // Mirror TypeORM's postgres RETURNING shape: [rows, affectedCount].
    return [updated, updated.length];
  });
  const lockRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ locked }];
      return [];
    }),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    createQueryRunner: jest.fn(() => lockRunner),
    query,
  };
  return { dataSource, lockRunner, query, store };
}

describe('PostLanguageBackfillService', () => {
  let savedSync: string | undefined;

  beforeEach(() => {
    savedSync = process.env.DISABLE_MDW_SYNC;
    delete process.env.DISABLE_MDW_SYNC;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (savedSync === undefined) delete process.env.DISABLE_MDW_SYNC;
    else process.env.DISABLE_MDW_SYNC = savedSync;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('onModuleInit scheduling', () => {
    it('schedules the deferred run when enabled', () => {
      jest.useFakeTimers();
      const { dataSource } = makeDataSource([]);
      const service = new PostLanguageBackfillService(dataSource as any);
      const run = jest
        .spyOn(service, 'runBackfill')
        .mockResolvedValue(undefined);

      service.onModuleInit();
      expect(run).not.toHaveBeenCalled(); // deferred, not on the boot path
      jest.advanceTimersByTime(30_000);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('does not schedule a run when live MDW sync is disabled', () => {
      jest.useFakeTimers();
      process.env.DISABLE_MDW_SYNC = 'true';
      const { dataSource } = makeDataSource([]);
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
    it('acquires the lock, backfills only null rows, then unlocks and releases', async () => {
      const { dataSource, lockRunner, query, store } = makeDataSource([
        { id: 'a', content: '我喜欢 bitcoin', language: null },
        { id: 'b', content: 'gm frens', language: 'ru' }, // wrong on purpose, must survive
        { id: 'c', content: 'Привет мир', language: null },
      ]);
      const service = new PostLanguageBackfillService(dataSource as any);

      await service.runBackfill();

      // Only null rows detected; the pre-set row is never overwritten.
      expect(store.find((r) => r.id === 'a')!.language).toBe('zh');
      expect(store.find((r) => r.id === 'c')!.language).toBe('ru');
      expect(store.find((r) => r.id === 'b')!.language).toBe('ru');
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
      // Conservative default batch size (500) drives the keyset SELECT.
      expect(query).toHaveBeenCalledWith(expect.any(String), ['', 500]);
    });

    it('resumes across runs, updating only rows still null', async () => {
      const fake = makeDataSource([
        { id: 'a', content: '我喜欢 bitcoin', language: null },
        { id: 'c', content: 'Привет мир', language: null },
      ]);
      const service = new PostLanguageBackfillService(fake.dataSource as any);

      await service.runBackfill();
      expect(fake.store.every((r) => r.language !== null)).toBe(true);

      // A second run finds nothing to do and re-touches nothing.
      const beforeCalls = fake.query.mock.calls.length;
      await service.runBackfill();
      // Only the single terminal SELECT (0 rows) — no UPDATE issued.
      const newCalls = fake.query.mock.calls.slice(beforeCalls);
      expect(newCalls).toHaveLength(1);
      expect(newCalls[0][0]).toContain('SELECT id, content FROM posts');
    });

    it('skips the backfill and does not unlock when another instance holds the lock', async () => {
      const { dataSource, lockRunner, query } = makeDataSource(
        [{ id: 'a', content: 'gm', language: null }],
        false,
      );
      const service = new PostLanguageBackfillService(dataSource as any);

      await service.runBackfill();

      expect(query).not.toHaveBeenCalled(); // backfill never ran
      const unlockCalls = lockRunner.query.mock.calls.filter(([sql]) =>
        String(sql).includes('pg_advisory_unlock'),
      );
      expect(unlockCalls).toHaveLength(0); // never unlock a lock we don't hold
      expect(lockRunner.release).toHaveBeenCalledTimes(1);
    });

    it('does nothing when live MDW sync is disabled', async () => {
      process.env.DISABLE_MDW_SYNC = 'true';
      const { dataSource } = makeDataSource([]);
      const service = new PostLanguageBackfillService(dataSource as any);

      await service.runBackfill();

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('does not overlap a run already in progress', async () => {
      const { dataSource } = makeDataSource([]);
      const service = new PostLanguageBackfillService(dataSource as any);
      (service as any).running = true;

      await service.runBackfill();

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('releases the lock even if the backfill throws', async () => {
      const { dataSource, lockRunner } = makeDataSource([]);
      (dataSource as any).query = jest
        .fn()
        .mockRejectedValue(new Error('db exploded'));
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

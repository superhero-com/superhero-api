import {
  backfillPostLanguage,
  parseBackfillOptions,
} from './backfill-post-language';

interface FakeRow {
  id: string;
  content: string | null;
  language: string | null;
}

/**
 * In-memory stand-in for the two statements the backfill issues: the keyset
 * SELECT of null-language rows and the guarded batch UPDATE. It enforces the
 * same `language IS NULL` guards Postgres would, so the null-only and resumable
 * behaviour is exercised without a real database.
 */
function makeFakeDb(rows: FakeRow[]) {
  const store = rows.map((r) => ({ ...r }));
  const query = jest.fn(async (sql: string, params: any[]) => {
    if (sql.includes('SELECT')) {
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
  return { query, store };
}

const opts = (
  over: Partial<Parameters<typeof backfillPostLanguage>[1]> = {},
) => ({
  dryRun: false,
  batchSize: 100,
  sleepMs: 0,
  maxBatches: Number.POSITIVE_INFINITY,
  ...over,
});

describe('parseBackfillOptions', () => {
  it('parses flags with defaults', () => {
    expect(parseBackfillOptions([])).toEqual({
      dryRun: false,
      batchSize: 500,
      sleepMs: 250,
      maxBatches: Number.POSITIVE_INFINITY,
    });
  });

  it('parses provided values', () => {
    expect(
      parseBackfillOptions([
        '--dry-run',
        '--batch-size=50',
        '--sleep-ms=0',
        '--max-batches=2',
      ]),
    ).toEqual({ dryRun: true, batchSize: 50, sleepMs: 0, maxBatches: 2 });
  });

  it('rejects a batch size outside 1..5000', () => {
    expect(() => parseBackfillOptions(['--batch-size=0'])).toThrow();
    expect(() => parseBackfillOptions(['--batch-size=5001'])).toThrow();
  });
});

describe('backfillPostLanguage', () => {
  it('fills only null rows and leaves an already-set row alone', async () => {
    const { query, store } = makeFakeDb([
      { id: 'a', content: '我喜欢 bitcoin', language: null },
      { id: 'b', content: 'gm frens', language: 'ru' }, // deliberately wrong, must be preserved
      { id: 'c', content: 'Привет мир', language: null },
    ]);

    const result = await backfillPostLanguage({ query } as any, opts());

    expect(store.find((r) => r.id === 'a')!.language).toBe('zh');
    expect(store.find((r) => r.id === 'c')!.language).toBe('ru');
    // Pre-set row is never re-detected or overwritten.
    expect(store.find((r) => r.id === 'b')!.language).toBe('ru');
    expect(result.updated).toBe(2);
    expect(result.counts).toEqual({ en: 0, zh: 1, ar: 0, ru: 1, und: 0 });
  });

  it('a dry run writes nothing', async () => {
    const { query, store } = makeFakeDb([
      { id: 'a', content: '我喜欢 bitcoin', language: null },
      { id: 'b', content: 'gm frens', language: null },
    ]);

    const result = await backfillPostLanguage(
      { query } as any,
      opts({ dryRun: true }),
    );

    // No UPDATE issued, rows still null.
    expect(query.mock.calls.every(([sql]) => sql.includes('SELECT'))).toBe(
      true,
    );
    expect(store.every((r) => r.language === null)).toBe(true);
    expect(result.updated).toBe(0);
    // Detection still ran and was tallied.
    expect(result.counts).toEqual({ en: 1, zh: 1, ar: 0, ru: 0, und: 0 });
  });

  it('resumes: a second run only updates rows still null', async () => {
    const fake = makeFakeDb([
      { id: 'a', content: '我喜欢 bitcoin', language: null },
      { id: 'b', content: 'gm frens', language: null },
      { id: 'c', content: 'Привет мир', language: null },
    ]);

    // First run stops after one small batch (batchSize 1, maxBatches 1): only 'a'.
    const first = await backfillPostLanguage(
      { query: fake.query } as any,
      opts({ batchSize: 1, maxBatches: 1 }),
    );
    expect(first.updated).toBe(1);
    expect(fake.store.find((r) => r.id === 'a')!.language).toBe('zh');
    expect(fake.store.find((r) => r.id === 'b')!.language).toBeNull();

    // Second run finishes the remaining null rows and does not re-touch 'a'.
    const second = await backfillPostLanguage(
      { query: fake.query } as any,
      opts({ batchSize: 100 }),
    );
    expect(second.updated).toBe(2);
    expect(fake.store.find((r) => r.id === 'b')!.language).toBe('en');
    expect(fake.store.find((r) => r.id === 'c')!.language).toBe('ru');
  });
});

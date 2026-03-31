import { batchTimestampToAeHeight } from './getBlochHeight';

// Suppress network-related console output during tests
const originalWarn = console.warn;
beforeAll(() => {
  console.warn = jest.fn();
});
afterAll(() => {
  console.warn = originalWarn;
});

describe('batchTimestampToAeHeight', () => {
  // Create a DataSource mock whose query() returns different results on first
  // call (key_blocks) vs. subsequent calls (transactions fallback).
  const makeDataSource = (
    keyBlocksResult: Array<{ target_ms: string; height: number | null }>,
    txFallbackResult: Array<{
      target_ms: string;
      block_height: number | null;
    }> = [],
  ) => ({
    query: jest
      .fn()
      .mockResolvedValueOnce(keyBlocksResult) // 1st call: key_blocks
      .mockResolvedValue(txFallbackResult), // subsequent: transactions
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty map for empty input without querying the DB', async () => {
    const dataSource = makeDataSource([]);

    const result = await batchTimestampToAeHeight([], dataSource as any);

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('resolves all timestamps from key_blocks in one query — no fallback needed', async () => {
    const ts1 = 1_700_000_000_000;
    const ts2 = 1_700_086_400_000;
    const dataSource = makeDataSource([
      { target_ms: String(ts1), height: 100 },
      { target_ms: String(ts2), height: 200 },
    ]);

    const result = await batchTimestampToAeHeight(
      [ts1, ts2],
      dataSource as any,
    );

    // Only one SQL round-trip when key_blocks resolves everything
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    const [sql, params] = dataSource.query.mock.calls[0];

    // key_blocks query: direct comparison (no CAST) enables index scan
    expect(sql).toContain('unnest($1::bigint[])');
    expect(sql).toContain('key_blocks');
    expect(sql).not.toContain('CAST(time AS bigint)');
    expect(sql).toContain('ORDER BY time DESC');
    expect(params).toEqual([[ts1, ts2]]);

    expect(result.get(ts1)).toBe(100);
    expect(result.get(ts2)).toBe(200);
  });

  it('falls back to transactions table for timestamps key_blocks returns null', async () => {
    const ts1 = 1_700_000_000_000; // resolved by key_blocks
    const ts2 = 1_700_086_400_000; // key_blocks gap → resolved by transactions

    const dataSource = makeDataSource(
      [
        { target_ms: String(ts1), height: 100 },
        { target_ms: String(ts2), height: null },
      ],
      [{ target_ms: String(ts2), block_height: 205 }],
    );

    const result = await batchTimestampToAeHeight(
      [ts1, ts2],
      dataSource as any,
    );

    // Two DB round-trips: key_blocks + transactions (no HTTP/guessing calls)
    expect(dataSource.query).toHaveBeenCalledTimes(2);

    const [txSql, txParams] = dataSource.query.mock.calls[1];
    expect(txSql).toContain('transactions');
    expect(txSql).toContain('created_at');
    expect(txSql).toContain('to_timestamp');
    expect(txSql).toContain('ORDER BY created_at DESC');
    // Only the unresolved timestamp is passed to the fallback query
    expect(txParams).toEqual([[ts2]]);

    expect(result.get(ts1)).toBe(100);
    expect(result.get(ts2)).toBe(205);
  });

  it('uses a LATERAL join with index-friendly direct column comparison', async () => {
    const ts = 1_700_000_000_000;
    const dataSource = makeDataSource([{ target_ms: String(ts), height: 555 }]);

    await batchTimestampToAeHeight([ts], dataSource as any);

    const [sql] = dataSource.query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN LATERAL');
    // No CAST wrapper — that would force a seq scan instead of index scan
    expect(sql).not.toContain('CAST(time AS bigint)');
    expect(sql).toContain('ORDER BY time DESC');
    expect(sql).toContain('LIMIT 1');
  });

  it('includes all input timestamps in the SQL parameter array', async () => {
    const timestamps = [
      1_700_000_000_000, 1_700_086_400_000, 1_700_172_800_000,
    ];
    const dataSource = makeDataSource(
      timestamps.map((ts, i) => ({ target_ms: String(ts), height: i + 1 })),
    );

    const result = await batchTimestampToAeHeight(
      timestamps,
      dataSource as any,
    );

    const [, params] = dataSource.query.mock.calls[0];
    expect(params[0]).toEqual(timestamps);
    expect(result.get(timestamps[0])).toBe(1);
    expect(result.get(timestamps[1])).toBe(2);
    expect(result.get(timestamps[2])).toBe(3);
  });
});

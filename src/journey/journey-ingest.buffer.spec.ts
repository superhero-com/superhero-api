import { JourneyIngestBuffer } from './journey-ingest.buffer';
import { JOURNEY_LIMITS } from './journey.constants';
import { JourneyEventRow } from './journey-payload';

function makeRows(count: number): JourneyEventRow[] {
  return Array.from({ length: count }, (_, i) => ({
    anon_id: '3f2b8c4e-9a1d-4c6e-8b7a-1d2e3f4a5b6c',
    event: 'page_view',
    page: '/',
    occurred_at: new Date(1_700_000_000_000 + i),
  }));
}

function makeRepository(execute: jest.Mock) {
  const builder: any = {
    insert: jest.fn(() => builder),
    into: jest.fn(() => builder),
    values: jest.fn((rows) => {
      builder.lastValues = rows;
      return builder;
    }),
    updateEntity: jest.fn(() => builder),
    execute: jest.fn(() => execute(builder.lastValues)),
  };
  return {
    builder,
    repository: { createQueryBuilder: jest.fn(() => builder) } as any,
  };
}

describe('JourneyIngestBuffer', () => {
  it('push() is synchronous and does not touch the database below the threshold', () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const { repository } = makeRepository(execute);
    const buffer = new JourneyIngestBuffer(repository);
    const result = buffer.push(makeRows(10));
    expect(result).toBeUndefined();
    expect(buffer.size).toBe(10);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('writes everything buffered in ONE bulk insert on flush', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const { repository, builder } = makeRepository(execute);
    const buffer = new JourneyIngestBuffer(repository);
    buffer.push(makeRows(3));
    buffer.push(makeRows(4));
    await buffer.flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(builder.values.mock.calls[0][0]).toHaveLength(7);
    expect(buffer.size).toBe(0);
  });

  it('flushes on its own once 500 rows are waiting', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const { repository } = makeRepository(execute);
    const buffer = new JourneyIngestBuffer(repository);
    buffer.push(makeRows(JOURNEY_LIMITS.FLUSH_AT_ROWS - 1));
    expect(execute).not.toHaveBeenCalled();
    buffer.push(makeRows(1));
    await buffer.flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toHaveLength(JOURNEY_LIMITS.FLUSH_AT_ROWS);
  });

  it('flushes on the 5 s timer and on module destroy', async () => {
    jest.useFakeTimers();
    try {
      const execute = jest.fn().mockResolvedValue(undefined);
      const { repository } = makeRepository(execute);
      const buffer = new JourneyIngestBuffer(repository);
      buffer.onModuleInit();
      buffer.push(makeRows(2));
      jest.advanceTimersByTime(JOURNEY_LIMITS.FLUSH_INTERVAL_MS);
      await Promise.resolve();
      expect(execute).toHaveBeenCalledTimes(1);

      buffer.push(makeRows(3));
      await buffer.onModuleDestroy();
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1][0]).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops rows beyond the 20 000 hard cap', () => {
    const execute = jest.fn(() => new Promise(() => undefined));
    const { repository } = makeRepository(execute);
    const buffer = new JourneyIngestBuffer(repository);
    // Keep the auto-flush from draining the buffer: the insert never settles.
    (buffer as any).flushing = new Promise(() => undefined);
    buffer.push(makeRows(JOURNEY_LIMITS.MAX_BUFFERED_ROWS - 5));
    buffer.push(makeRows(10));
    expect(buffer.size).toBe(JOURNEY_LIMITS.MAX_BUFFERED_ROWS);
    expect(buffer.droppedCount).toBe(5);
    buffer.push(makeRows(3));
    expect(buffer.size).toBe(JOURNEY_LIMITS.MAX_BUFFERED_ROWS);
    expect(buffer.droppedCount).toBe(8);
  });

  it('drops a failed batch, logs once without the payload, and keeps working', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('value "secret" broke'), { code: '22P02' }),
      )
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValue(undefined);
    const { repository } = makeRepository(execute);
    const buffer = new JourneyIngestBuffer(repository);
    const warn = jest
      .spyOn((buffer as any).logger, 'warn')
      .mockImplementation(() => undefined);

    buffer.push(makeRows(2));
    await expect(buffer.flush()).resolves.toBeUndefined();
    buffer.push(makeRows(2));
    await buffer.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('22P02');
    expect(String(warn.mock.calls[0][0])).not.toContain('secret');
    expect(buffer.droppedCount).toBe(4);
    expect(buffer.size).toBe(0);

    buffer.push(makeRows(1));
    await buffer.flush();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('splits a large backlog into inserts of at most 2000 rows', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const { repository } = makeRepository(execute);
    const buffer = new JourneyIngestBuffer(repository);
    (buffer as any).rows = makeRows(4500);
    await buffer.flush();
    expect(execute.mock.calls.map((c) => c[0].length)).toEqual([
      2000, 2000, 500,
    ]);
  });

  it('ignores an empty push', () => {
    const { repository } = makeRepository(jest.fn());
    const buffer = new JourneyIngestBuffer(repository);
    buffer.push([]);
    expect(buffer.size).toBe(0);
  });
});

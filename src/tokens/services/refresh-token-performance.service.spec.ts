import { Logger } from '@nestjs/common';
import {
  DELETE_STALE_TOKEN_PERFORMANCE_SQL,
  UPSERT_TOKEN_PERFORMANCE_SQL,
} from '../utils/token-performance-sql.util';
import {
  REFRESH_TOKEN_PERFORMANCE_LOCK_KEY,
  RefreshTokenPerformanceService,
} from './refresh-token-performance.service';

function createService(locked: boolean) {
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(
    async (sql) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return [{ locked }];
      }
      if (sql === DELETE_STALE_TOKEN_PERFORMANCE_SQL) {
        return [{ count: 2 }];
      }
      if (sql === UPSERT_TOKEN_PERFORMANCE_SQL) {
        return [{ count: 5 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  );
  const dataSource = {
    transaction: jest.fn(async (work: (manager: any) => unknown) =>
      work({ query }),
    ),
  };
  return {
    service: new RefreshTokenPerformanceService(dataSource as any),
    query,
  };
}

describe('RefreshTokenPerformanceService', () => {
  it('removes stale rows and upserts changed ones under the advisory lock', async () => {
    const { service, query } = createService(true);

    await expect(service.refreshPerformance()).resolves.toEqual({
      changed: 5,
      removed: 2,
    });

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      DELETE_STALE_TOKEN_PERFORMANCE_SQL,
      UPSERT_TOKEN_PERFORMANCE_SQL,
    ]);
    expect(query.mock.calls[0][1]).toEqual([
      REFRESH_TOKEN_PERFORMANCE_LOCK_KEY,
    ]);
  });

  it('skips when another refresh holds the lock', async () => {
    const { service, query } = createService(false);

    await expect(service.refreshPerformance()).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows errors instead of throwing', async () => {
    const dataSource = {
      transaction: jest.fn().mockRejectedValue(new Error('db unavailable')),
    };
    const service = new RefreshTokenPerformanceService(dataSource as any);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(service.refreshPerformance()).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalled();
    loggerError.mockRestore();
  });
});

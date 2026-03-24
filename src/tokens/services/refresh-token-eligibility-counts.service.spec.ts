import { RefreshTokenEligibilityCountsService } from './refresh-token-eligibility-counts.service';

describe('RefreshTokenEligibilityCountsService', () => {
  let service: RefreshTokenEligibilityCountsService;
  let dataSource: {
    query: jest.Mock;
    transaction: jest.Mock;
  };
  let manager: {
    query: jest.Mock;
  };

  beforeEach(() => {
    manager = {
      query: jest.fn(),
    };
    dataSource = {
      query: jest.fn(),
      transaction: jest.fn().mockImplementation(async (callback) => {
        await callback(manager);
      }),
    };

    service = new RefreshTokenEligibilityCountsService(dataSource as any);
  });

  it('creates the tables and performs a full rebuild on first refresh', async () => {
    dataSource.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ count: 12 }]);
    manager.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM token_eligibility_refresh_state')) {
        return [];
      }
      if (sql.includes('ORDER BY post.created_at DESC')) {
        return [{ created_at: '2026-03-24T00:00:00.000Z', id: 'post-9' }];
      }
      if (sql.includes('SELECT COUNT(*)::int AS total_posts')) {
        return [{ total_posts: 9 }];
      }
      return [];
    });

    await service.manualRefresh();

    expect(dataSource.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('CREATE TABLE IF NOT EXISTS token_eligibility_counts'),
    );
    expect(dataSource.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'CREATE TABLE IF NOT EXISTS token_eligibility_refresh_state',
      ),
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('TRUNCATE TABLE token_eligibility_counts'),
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO token_eligibility_counts'),
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO token_eligibility_refresh_state'),
      ['default', '2026-03-24T00:00:00.000Z', 'post-9'],
    );
    expect(dataSource.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('SELECT COUNT(*)::int AS count'),
    );
  });

  it('applies incremental updates using the stored watermark', async () => {
    dataSource.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ count: 14 }]);
    manager.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('FROM token_eligibility_refresh_state')) {
        return [
          {
            last_processed_created_at: '2026-03-24T00:00:00.000Z',
            last_processed_post_id: 'post-9',
          },
        ];
      }
      if (sql.includes('ORDER BY post.created_at DESC')) {
        return [{ created_at: '2026-03-24T01:00:00.000Z', id: 'post-11' }];
      }
      if (sql.includes('SELECT COUNT(*)::int AS processed_count')) {
        expect(sql).toContain('post.created_at < $3');
        expect(sql).toContain('post.id <= $4');
        expect(params).toEqual([
          '2026-03-24T00:00:00.000Z',
          'post-9',
          '2026-03-24T01:00:00.000Z',
          'post-11',
        ]);
        return [{ processed_count: 2 }];
      }
      if (sql.includes('INSERT INTO token_eligibility_counts')) {
        expect(sql).toContain('post.created_at < $3');
        expect(sql).toContain('post.id <= $4');
        expect(params).toEqual([
          '2026-03-24T00:00:00.000Z',
          'post-9',
          '2026-03-24T01:00:00.000Z',
          'post-11',
        ]);
        return [];
      }
      return [];
    });

    await service.manualRefresh();

    expect(manager.query).not.toHaveBeenCalledWith(
      'TRUNCATE TABLE token_eligibility_counts',
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (symbol) DO UPDATE'),
      [
        '2026-03-24T00:00:00.000Z',
        'post-9',
        '2026-03-24T01:00:00.000Z',
        'post-11',
      ],
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO token_eligibility_refresh_state'),
      ['default', '2026-03-24T01:00:00.000Z', 'post-11'],
    );
  });

  it('logs a no-op refresh when there are no new posts after the watermark', async () => {
    const loggerLog = jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);
    dataSource.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ count: 12 }]);
    manager.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM token_eligibility_refresh_state')) {
        return [
          {
            last_processed_created_at: '2026-03-24T00:00:00.000Z',
            last_processed_post_id: 'post-9',
          },
        ];
      }
      if (sql.includes('ORDER BY post.created_at DESC')) {
        return [];
      }
      return [];
    });

    await service.manualRefresh();

    expect(manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO token_eligibility_counts'),
      expect.anything(),
    );
    expect(loggerLog).toHaveBeenCalledWith(
      expect.stringContaining('(12 symbols, 0 posts processed)'),
    );
  });

  it('skips a refresh when one is already running', async () => {
    (service as any).isRefreshing = true;

    await service.manualRefresh();

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('logs and resets state when refresh fails', async () => {
    const loggerError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    dataSource.query.mockRejectedValueOnce(new Error('ddl failed'));

    await expect(service.manualRefresh()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      'Failed to refresh token eligibility counts via manual',
      expect.stringContaining('ddl failed'),
    );
    expect((service as any).isRefreshing).toBe(false);
  });

  it('refreshes on module init', async () => {
    dataSource.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ count: 3 }]);
    manager.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM token_eligibility_refresh_state')) {
        return [];
      }
      if (sql.includes('ORDER BY post.created_at DESC')) {
        return [{ created_at: '2026-03-24T00:00:00.000Z', id: 'post-3' }];
      }
      if (sql.includes('SELECT COUNT(*)::int AS total_posts')) {
        return [{ total_posts: 3 }];
      }
      return [];
    });

    await service.onModuleInit();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });
});

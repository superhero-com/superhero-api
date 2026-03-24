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

  it('creates the table before refreshing counts', async () => {
    dataSource.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce([
      { count: 12 },
    ]);

    await service.manualRefresh();

    expect(dataSource.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('CREATE TABLE IF NOT EXISTS token_eligibility_counts'),
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      'TRUNCATE TABLE token_eligibility_counts',
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO token_eligibility_counts'),
    );
    expect(dataSource.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT COUNT(*)::int AS count'),
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
    dataSource.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce([
      { count: 3 },
    ]);

    await service.onModuleInit();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });
});

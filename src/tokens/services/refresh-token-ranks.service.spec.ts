import { Logger } from '@nestjs/common';
import { RefreshTokenRanksService } from './refresh-token-ranks.service';
import { TOKEN_MAINTENANCE_LOCK_KEY } from '../utils/token-maintenance-lock.util';

function createService(query: jest.Mock) {
  return new RefreshTokenRanksService({
    transaction: async (work) => work({ query }),
  } as any);
}

describe('RefreshTokenRanksService', () => {
  it('runs a single set-based UPDATE ... RANK() OVER query', async () => {
    const query = jest.fn().mockResolvedValue([{ locked: true }]);
    const service = createService(query);

    await service.refreshRanks();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual([
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [TOKEN_MAINTENANCE_LOCK_KEY],
    ]);
    const [sql] = query.mock.calls[1];
    expect(sql).toContain('UPDATE "token"');
    expect(sql).toContain('RANK() OVER');
    expect(sql).toContain('WHERE unlisted = false');
  });

  it('skips while another maintenance job holds the lock', async () => {
    const query = jest.fn().mockResolvedValue([{ locked: false }]);
    await createService(query).refreshRanks();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows errors instead of throwing', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db unavailable'));
    const service = createService(query);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(service.refreshRanks()).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalled();
    loggerError.mockRestore();
  });

  it('manualRefresh delegates to refreshRanks', async () => {
    const query = jest.fn().mockResolvedValue([{ locked: true }]);
    const service = createService(query);
    const spy = jest.spyOn(service, 'refreshRanks');

    await service.manualRefresh();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

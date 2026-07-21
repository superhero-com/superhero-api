import { Logger } from '@nestjs/common';
import { RefreshTokenRanksService } from './refresh-token-ranks.service';

describe('RefreshTokenRanksService', () => {
  it('runs a single set-based UPDATE ... RANK() OVER query', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = new RefreshTokenRanksService({ query } as any);

    await service.refreshRanks();

    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('UPDATE "token"');
    expect(sql).toContain('RANK() OVER');
    expect(sql).toContain('WHERE unlisted = false');
  });

  it('logs and swallows errors instead of throwing', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db unavailable'));
    const service = new RefreshTokenRanksService({ query } as any);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(service.refreshRanks()).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalled();
    loggerError.mockRestore();
  });

  it('manualRefresh delegates to refreshRanks', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = new RefreshTokenRanksService({ query } as any);
    const spy = jest.spyOn(service, 'refreshRanks');

    await service.manualRefresh();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

import { UpdateTrendingScoresQueue } from './update-trending-scores.queue';

describe('UpdateTrendingScoresQueue', () => {
  it('delegates to TokensService.updateTrendingScoresForSymbols for the job symbol', async () => {
    const tokenService = {
      updateTrendingScoresForSymbols: jest.fn().mockResolvedValue(undefined),
    };
    const queue = new UpdateTrendingScoresQueue(tokenService as any);

    await queue.process({ data: { symbol: 'ALPHA' } } as any);

    expect(tokenService.updateTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
    ]);
  });

  it('rethrows so Bull can retry a failed recompute', async () => {
    const tokenService = {
      updateTrendingScoresForSymbols: jest
        .fn()
        .mockRejectedValue(new Error('boom')),
    };
    const queue = new UpdateTrendingScoresQueue(tokenService as any);

    await expect(
      queue.process({ data: { symbol: 'ALPHA' } } as any),
    ).rejects.toThrow('boom');
  });
});

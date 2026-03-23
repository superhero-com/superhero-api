import { LeaderboardSnapshotService } from './leaderboard-snapshot.service';

describe('LeaderboardSnapshotService', () => {
  it('reuses cached pnl promises for the same address and block height', async () => {
    const pnlResult = {
      pnls: {},
      totalCostBasisAe: 1,
      totalCostBasisUsd: 1,
      totalCurrentValueAe: 2,
      totalCurrentValueUsd: 2,
      totalGainAe: 1,
      totalGainUsd: 1,
    };
    const bclPnlService = {
      calculateTokenPnls: jest.fn().mockResolvedValue(pnlResult),
    };

    const service = new LeaderboardSnapshotService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      bclPnlService as any,
      {} as any,
    );

    const cache = new Map();
    const first = (service as any).getCachedTokenPnl(cache, 'ak_test', 42);
    const second = (service as any).getCachedTokenPnl(cache, 'ak_test', 42);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(pnlResult);
    expect(secondResult).toBe(pnlResult);
    expect(bclPnlService.calculateTokenPnls).toHaveBeenCalledTimes(1);
    expect(bclPnlService.calculateTokenPnls).toHaveBeenCalledWith(
      'ak_test',
      42,
    );
  });
});

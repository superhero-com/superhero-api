import { LeaderboardSnapshotService } from './leaderboard-snapshot.service';
import { LEADERBOARD_SNAPSHOT_MAX_CANDIDATES } from './leaderboard.types';

describe('LeaderboardSnapshotService', () => {
  it('pins LEADERBOARD_SNAPSHOT_MAX_CANDIDATES to its expected ceiling', () => {
    // The read path's inline `COUNT(*) OVER()` is O(≤N) only because each
    // leaderboard window is materialized at most this many rows. Bumping this
    // value means revisiting the read service's docs and (possibly) switching
    // to cursor pagination — see leaderboard.service.ts comments.
    expect(LEADERBOARD_SNAPSHOT_MAX_CANDIDATES).toBe(100);
  });

  it('passes LEADERBOARD_SNAPSHOT_MAX_CANDIDATES into computeWindow for every window', async () => {
    const service = new LeaderboardSnapshotService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        manager: {
          transaction: jest.fn(),
        },
      } as any,
      {} as any,
      {} as any,
    );

    const computeSpy = jest
      .spyOn(service as any, 'computeWindow')
      .mockResolvedValue([]);

    await service.refreshAllWindows();

    const observedWindows = computeSpy.mock.calls.map((call) => call[0]);
    expect(observedWindows).toEqual(['7d', '30d', 'all']);
    for (const call of computeSpy.mock.calls) {
      expect(call[1]).toBe(LEADERBOARD_SNAPSHOT_MAX_CANDIDATES);
    }
  });

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

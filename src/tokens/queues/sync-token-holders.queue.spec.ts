import { recordSyncTokenHoldersDuration } from '@/utils/stabilization-metrics';
import { SyncTokenHoldersQueue } from './sync-token-holders.queue';

jest.mock('@/utils/stabilization-metrics', () => ({
  recordSyncTokenHoldersDuration: jest.fn(),
}));

describe('SyncTokenHoldersQueue', () => {
  const saleAddress = 'ct_testAddress' as any;
  let tokenService: { loadAndSaveTokenHoldersFromMdw: jest.Mock };
  let queue: SyncTokenHoldersQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    tokenService = {
      loadAndSaveTokenHoldersFromMdw: jest.fn(),
    };
    queue = new SyncTokenHoldersQueue(tokenService as any);
  });

  it('clears timeout handle when sync completes quickly', async () => {
    tokenService.loadAndSaveTokenHoldersFromMdw.mockResolvedValue(undefined);
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    await queue.process({ data: { saleAddress } } as any);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(recordSyncTokenHoldersDuration).toHaveBeenCalledTimes(1);
  });

  it('joins in-flight sync for the same token and avoids overlap', async () => {
    let resolveFirst: () => void = () => undefined;
    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    tokenService.loadAndSaveTokenHoldersFromMdw.mockReturnValue(firstPromise);

    const firstJob = queue.process({ data: { saleAddress } } as any);
    const secondJob = queue.process({ data: { saleAddress } } as any);

    expect(tokenService.loadAndSaveTokenHoldersFromMdw).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([firstJob, secondJob]);

    expect(tokenService.loadAndSaveTokenHoldersFromMdw).toHaveBeenCalledTimes(1);
  });

  it('join-inflight path times out so queue recovery can retry', async () => {
    jest.useFakeTimers();
    (queue as any).jobTimeoutMs = 50;

    const neverResolving = new Promise<void>(() => {});
    tokenService.loadAndSaveTokenHoldersFromMdw.mockReturnValue(neverResolving);

    const firstJobPromise = queue
      .process({ data: { saleAddress } } as any)
      .catch(() => {});
    await jest.advanceTimersByTimeAsync(5);

    const joiningJobPromise = queue
      .process({ data: { saleAddress } } as any)
      .catch((e: Error) => e);

    await jest.advanceTimersByTimeAsync(50);
    const [_, joinResult] = await Promise.all([
      firstJobPromise,
      joiningJobPromise,
    ]);
    expect(joinResult).toBeInstanceOf(Error);
    expect((joinResult as Error).message).toMatch(/timeout/);

    jest.useRealTimers();
  });

  it('after main sync times out, inFlightSyncs is cleared so next job can start a fresh sync', async () => {
    jest.useFakeTimers();
    (queue as any).jobTimeoutMs = 10;

    const firstPromise = new Promise<void>(() => {});

    let resolveSecond: () => void = () => undefined;
    const secondPromise = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });

    tokenService.loadAndSaveTokenHoldersFromMdw
      .mockReturnValueOnce(firstPromise)
      .mockReturnValueOnce(secondPromise);

    const firstJobPromise = queue
      .process({ data: { saleAddress } } as any)
      .catch((error) => error);

    await jest.advanceTimersByTimeAsync(20);
    const firstError = await firstJobPromise;
    expect(firstError).toBeInstanceOf(Error);

    const secondJobPromise = queue.process({ data: { saleAddress } } as any);
    expect(tokenService.loadAndSaveTokenHoldersFromMdw).toHaveBeenCalledTimes(2);

    resolveSecond();
    await secondJobPromise;

    jest.useRealTimers();
  });
});

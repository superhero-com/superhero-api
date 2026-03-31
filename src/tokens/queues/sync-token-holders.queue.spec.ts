import { recordSyncTokenHoldersDuration } from '@/utils/stabilization-metrics';
import { SyncTokenHoldersQueue } from './sync-token-holders.queue';
import { RetryableTokenHoldersSyncError } from '../tokens.service';

jest.mock('@/utils/stabilization-metrics', () => ({
  recordSyncTokenHoldersDuration: jest.fn(),
}));

describe('SyncTokenHoldersQueue', () => {
  const saleAddress = 'ct_testAddress' as any;
  let tokenService: { loadAndSaveTokenHoldersFromMdw: jest.Mock };
  let tokenHoldersLockService: {
    acquireLock: jest.Mock;
    releaseLock: jest.Mock;
  };
  let queue: SyncTokenHoldersQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    tokenService = {
      loadAndSaveTokenHoldersFromMdw: jest.fn(),
    };
    tokenHoldersLockService = {
      acquireLock: jest.fn().mockResolvedValue('lock-owner'),
      releaseLock: jest.fn().mockResolvedValue(true),
    };
    queue = new SyncTokenHoldersQueue(
      tokenService as any,
      tokenHoldersLockService as any,
    );
  });

  it('clears timeout handle when sync completes quickly', async () => {
    tokenService.loadAndSaveTokenHoldersFromMdw.mockResolvedValue(undefined);
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    await queue.process({ data: { saleAddress } } as any);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(recordSyncTokenHoldersDuration).toHaveBeenCalledTimes(1);
    expect(tokenHoldersLockService.acquireLock).toHaveBeenCalledWith(
      saleAddress,
    );
    expect(tokenHoldersLockService.releaseLock).toHaveBeenCalledWith(
      saleAddress,
      'lock-owner',
    );
  });

  it('skips processing when distributed lock is not acquired', async () => {
    tokenHoldersLockService.acquireLock.mockResolvedValue(null);

    await queue.process({ data: { saleAddress } } as any);

    expect(tokenService.loadAndSaveTokenHoldersFromMdw).not.toHaveBeenCalled();
    expect(tokenHoldersLockService.releaseLock).not.toHaveBeenCalled();
  });

  it('joins in-flight sync for the same token and avoids overlap', async () => {
    let resolveFirst: () => void = () => undefined;
    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    tokenService.loadAndSaveTokenHoldersFromMdw.mockReturnValue(firstPromise);

    const firstJob = queue.process({ data: { saleAddress } } as any);
    await Promise.resolve();
    const secondJob = queue.process({ data: { saleAddress } } as any);
    await Promise.resolve();

    expect(tokenService.loadAndSaveTokenHoldersFromMdw).toHaveBeenCalledTimes(
      1,
    );

    resolveFirst();
    await Promise.all([firstJob, secondJob]);

    expect(tokenService.loadAndSaveTokenHoldersFromMdw).toHaveBeenCalledTimes(
      1,
    );
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
    const [, joinResult] = await Promise.all([
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
    await Promise.resolve();
    expect(tokenService.loadAndSaveTokenHoldersFromMdw).toHaveBeenCalledTimes(
      2,
    );

    resolveSecond();
    await secondJobPromise;

    jest.useRealTimers();
  });

  it('releases distributed lock when sync throws', async () => {
    tokenService.loadAndSaveTokenHoldersFromMdw.mockRejectedValue(
      new Error('sync failed'),
    );

    await expect(
      queue.process({ data: { saleAddress } } as any),
    ).rejects.toThrow('sync failed');

    expect(tokenHoldersLockService.releaseLock).toHaveBeenCalledWith(
      saleAddress,
      'lock-owner',
    );
  });

  it('schedules a delayed retry for contract-not-ready sync failures', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    tokenService.loadAndSaveTokenHoldersFromMdw.mockRejectedValue(
      new RetryableTokenHoldersSyncError('contract not ready', 60_000),
    );

    await queue.process({
      data: { saleAddress },
      queue: { add },
    } as any);

    expect(add).toHaveBeenCalledWith(
      { saleAddress },
      expect.objectContaining({
        jobId: `syncTokenHolders-retry-${saleAddress}`,
        delay: 60_000,
        attempts: 1,
      }),
    );
    expect(tokenHoldersLockService.releaseLock).toHaveBeenCalledWith(
      saleAddress,
      'lock-owner',
    );
  });
});

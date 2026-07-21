import { FeedRetentionService } from './feed-retention.service';

describe('FeedRetentionService', () => {
  let repo: any;
  let feed: any;
  let em: any;
  let service: FeedRetentionService;
  const config = {
    feedRetentionDays: 90,
    feedMaxRowsPerAddress: 500,
    feedRetentionDeleteBatchSize: 10_000,
  } as any;

  /** Build a repo whose manager.transaction runs the callback against `em`. */
  const makeRepo = (lockAcquired: boolean) => {
    em = {
      query: jest
        .fn()
        .mockResolvedValue([{ pg_try_advisory_xact_lock: lockAcquired }]),
    };
    return {
      manager: {
        transaction: jest.fn((cb: any) => cb(em)),
      },
    };
  };

  it('prunes the feed when the advisory lock is acquired', async () => {
    repo = makeRepo(true);
    feed = { prune: jest.fn().mockResolvedValue(undefined) };
    service = new FeedRetentionService(repo, feed, config);

    await service.prune();

    expect(feed.prune).toHaveBeenCalledWith(em, 90, 500, 10_000);
  });

  it('skips pruning when another replica holds the lock', async () => {
    repo = makeRepo(false);
    feed = { prune: jest.fn() };
    service = new FeedRetentionService(repo, feed, config);

    await service.prune();

    expect(feed.prune).not.toHaveBeenCalled();
  });

  it('swallows errors so the cron never crashes the scheduler', async () => {
    repo = {
      manager: {
        transaction: jest.fn().mockRejectedValue(new Error('db down')),
      },
    };
    feed = { prune: jest.fn() };
    service = new FeedRetentionService(repo, feed, config);

    await expect(service.prune()).resolves.toBeUndefined();
  });
});

import { AnnouncementSchedulerService } from './announcement-scheduler.service';

/**
 * Covers the tick() orchestration — the densest concurrency logic in the
 * subsystem: drain loop, crash → releaseClaim, attempt-cap → markPoisoned,
 * missing-token skip, and wake/cron re-entrancy coalescing.
 */
describe('AnnouncementSchedulerService', () => {
  const config = { enabled: true, staleClaimMs: 300_000 } as any;

  function setup() {
    const announcements = {
      releaseStuck: jest.fn().mockResolvedValue(0),
      claimNextDue: jest.fn().mockResolvedValue(null),
      releaseClaim: jest.fn().mockResolvedValue(1),
      markPoisoned: jest.fn().mockResolvedValue(undefined),
    };
    const dispatch = { run: jest.fn().mockResolvedValue(undefined) };
    const service = new AnnouncementSchedulerService(
      announcements as any,
      dispatch as any,
      config,
    );
    return { service, announcements, dispatch };
  }

  it('no-ops entirely when disabled', async () => {
    const announcements = { releaseStuck: jest.fn(), claimNextDue: jest.fn() };
    const dispatch = { run: jest.fn() };
    const svc = new AnnouncementSchedulerService(
      announcements as any,
      dispatch as any,
      { enabled: false } as any,
    );
    await svc.tick();
    expect(announcements.releaseStuck).not.toHaveBeenCalled();
    expect(announcements.claimNextDue).not.toHaveBeenCalled();
  });

  it('drains every due row then stops on the first null claim', async () => {
    const { service, announcements, dispatch } = setup();
    announcements.claimNextDue
      .mockResolvedValueOnce({ id: 1, claim_token: 't1' })
      .mockResolvedValueOnce({ id: 2, claim_token: 't2' })
      .mockResolvedValue(null);

    await service.tick();

    expect(announcements.releaseStuck).toHaveBeenCalledTimes(1);
    expect(dispatch.run).toHaveBeenCalledTimes(2);
    expect(dispatch.run.mock.calls[0][0].id).toBe(1);
    expect(dispatch.run.mock.calls[1][0].id).toBe(2);
  });

  it('releases the claim (for retry) when dispatch crashes, without poisoning below the cap', async () => {
    const { service, announcements, dispatch } = setup();
    announcements.claimNextDue
      .mockResolvedValueOnce({ id: 9, claim_token: 't9' })
      .mockResolvedValue(null);
    dispatch.run.mockRejectedValueOnce(new Error('boom'));
    announcements.releaseClaim.mockResolvedValue(1); // below cap (3)

    await service.tick();

    expect(announcements.releaseClaim).toHaveBeenCalledWith(9, 't9');
    expect(announcements.markPoisoned).not.toHaveBeenCalled();
  });

  it('poisons a row once its persisted attempt_count crosses the cap', async () => {
    const { service, announcements, dispatch } = setup();
    announcements.claimNextDue
      .mockResolvedValueOnce({ id: 9, claim_token: 't9' })
      .mockResolvedValue(null);
    dispatch.run.mockRejectedValueOnce(new Error('boom'));
    announcements.releaseClaim.mockResolvedValue(3); // hits cap

    await service.tick();

    expect(announcements.markPoisoned).toHaveBeenCalledWith(
      9,
      expect.stringContaining('boom'),
    );
  });

  it('does not release a claim it cannot prove ownership of (no claim_token)', async () => {
    const { service, announcements, dispatch } = setup();
    announcements.claimNextDue
      .mockResolvedValueOnce({ id: 9, claim_token: null })
      .mockResolvedValue(null);
    dispatch.run.mockRejectedValueOnce(new Error('boom'));

    await service.tick();

    expect(announcements.releaseClaim).not.toHaveBeenCalled();
    expect(announcements.markPoisoned).not.toHaveBeenCalled();
  });

  it('coalesces a wake that arrives mid-drain into exactly one extra drain', async () => {
    const { service, announcements } = setup();
    let reentered = false;
    // Simulate a wake/cron firing while the first drain is in flight: the
    // re-entrant tick() sees running===true, sets pending, and returns.
    announcements.releaseStuck.mockImplementation(async () => {
      if (!reentered) {
        reentered = true;
        await service.tick(); // re-entrant — should just set pending
      }
      return 0;
    });

    await service.tick();

    // Two drain iterations: the original + one coalesced follow-up.
    expect(announcements.releaseStuck).toHaveBeenCalledTimes(2);
  });

  it('never throws even if releaseStuck itself fails', async () => {
    const { service, announcements } = setup();
    announcements.releaseStuck.mockRejectedValue(new Error('db down'));
    await expect(service.tick()).resolves.toBeUndefined();
  });
});

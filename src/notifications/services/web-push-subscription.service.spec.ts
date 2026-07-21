import { Logger } from '@nestjs/common';
import { WebPushSubscriptionService } from './web-push-subscription.service';

describe('WebPushSubscriptionService', () => {
  let repo: any;
  let service: WebPushSubscriptionService;

  beforeEach(() => {
    repo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    service = new WebPushSubscriptionService(repo);
  });

  it('upserts on the endpoint so a re-subscribe re-points instead of duplicating', async () => {
    await service.upsert('ak_owner', {
      endpoint: 'https://push.example/abc',
      p256dh: 'p',
      auth: 'a',
      userAgent: 'Firefox',
    });
    const [row, conflictPaths] = repo.upsert.mock.calls[0];
    expect(conflictPaths).toEqual(['endpoint']);
    expect(row).toEqual(
      expect.objectContaining({
        address: 'ak_owner',
        endpoint: 'https://push.example/abc',
        p256dh: 'p',
        auth: 'a',
        user_agent: 'Firefox',
      }),
    );
  });

  it('defaults a missing userAgent to null', async () => {
    await service.upsert('ak_owner', {
      endpoint: 'https://push.example/abc',
      p256dh: 'p',
      auth: 'a',
    });
    expect(repo.upsert.mock.calls[0][0]).toEqual(
      expect.objectContaining({ user_agent: null }),
    );
  });

  it('allows a brand-new endpoint (no existing row to conflict with)', async () => {
    repo.findOne.mockResolvedValue(null);
    await service.upsert('ak_owner', {
      endpoint: 'https://push.example/new',
      p256dh: 'p',
      auth: 'a',
    });
    expect(repo.upsert).toHaveBeenCalled();
  });

  it('allows refreshing a subscription already owned by the same address, even with rotated keys', async () => {
    repo.findOne.mockResolvedValue({
      address: 'ak_owner',
      p256dh: 'old-p',
      auth: 'old-a',
    });
    await service.upsert('ak_owner', {
      endpoint: 'https://push.example/abc',
      p256dh: 'new-p',
      auth: 'new-a',
    });
    expect(repo.upsert).toHaveBeenCalled();
  });

  it('allows re-pointing to a different address regardless of key match (same browser switching accounts) — see the doc comment for why a stricter key-match gate was reverted', async () => {
    repo.findOne.mockResolvedValue({
      address: 'ak_previous',
      p256dh: 'p',
      auth: 'a',
    });
    await service.upsert('ak_new', {
      endpoint: 'https://push.example/abc',
      p256dh: 'p',
      auth: 'a',
    });
    expect(repo.upsert).toHaveBeenCalled();
  });

  it('does NOT reject re-pointing when the subscription keys differ from what is on file', async () => {
    // Regression: a stricter "keys must match" gate was tried and reverted —
    // it let an attacker who registers a victim's (leaked) endpoint FIRST
    // with forged keys permanently lock the real owner out once no existing
    // row yet exists to compare against. Unconditional re-pointing is at
    // least self-healing: the real owner can always reclaim their endpoint
    // by re-subscribing again.
    repo.findOne.mockResolvedValue({
      address: 'ak_previous',
      p256dh: 'previous-p256dh',
      auth: 'previous-auth',
    });
    await expect(
      service.upsert('ak_new', {
        endpoint: 'https://push.example/abc',
        p256dh: 'different-p256dh',
        auth: 'different-auth',
      }),
    ).resolves.toBeUndefined();
    expect(repo.upsert).toHaveBeenCalled();
  });

  it('logs a warning when an endpoint is re-pointed to a different address, for visibility rather than enforcement', async () => {
    const loggerWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    repo.findOne.mockResolvedValue({
      address: 'ak_previous',
      p256dh: 'p',
      auth: 'a',
    });

    await service.upsert('ak_new', {
      endpoint: 'https://push.example/abc',
      p256dh: 'p',
      auth: 'a',
    });

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('ak_previous'),
    );
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('ak_new'));
    loggerWarn.mockRestore();
  });

  it('does not log when the address is unchanged (same-owner refresh)', async () => {
    const loggerWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    repo.findOne.mockResolvedValue({
      address: 'ak_owner',
      p256dh: 'p',
      auth: 'a',
    });

    await service.upsert('ak_owner', {
      endpoint: 'https://push.example/abc',
      p256dh: 'p',
      auth: 'a',
    });

    expect(loggerWarn).not.toHaveBeenCalled();
    loggerWarn.mockRestore();
  });

  it('does not log for a brand-new endpoint (nothing to re-point)', async () => {
    const loggerWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    repo.findOne.mockResolvedValue(null);

    await service.upsert('ak_owner', {
      endpoint: 'https://push.example/new',
      p256dh: 'p',
      auth: 'a',
    });

    expect(loggerWarn).not.toHaveBeenCalled();
    loggerWarn.mockRestore();
  });

  it('removes a subscription scoped to its owning address', async () => {
    await service.remove('ak_owner', 'https://push.example/abc');
    expect(repo.delete).toHaveBeenCalledWith({
      address: 'ak_owner',
      endpoint: 'https://push.example/abc',
    });
  });

  it('prunes a dead endpoint regardless of address', async () => {
    await service.prune('https://push.example/abc');
    expect(repo.delete).toHaveBeenCalledWith({
      endpoint: 'https://push.example/abc',
    });
  });

  it('lists subscriptions for an address', async () => {
    const subs = [{ id: 1 }];
    repo.find.mockResolvedValue(subs);
    await expect(service.getActiveForAddress('ak_owner')).resolves.toBe(subs);
    expect(repo.find).toHaveBeenCalledWith({ where: { address: 'ak_owner' } });
  });
});

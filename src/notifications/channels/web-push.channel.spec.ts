import { WebPushChannel } from './web-push.channel';
import { InvitationClaimedNotification } from '../notifications/invitation-claimed.notification';

describe('WebPushChannel', () => {
  let subscriptions: any;
  let dedup: any;
  let client: any;
  let queue: any;
  let channel: WebPushChannel;

  const notifiable = { address: 'ak_recipient' as any };
  const notification = new InvitationClaimedNotification({
    inviter: 'ak_recipient',
    claimer: 'ak_claimer',
    amountAe: '1',
    txHash: 'th_1',
  });

  const sub = {
    endpoint: 'https://push.example/abc',
    p256dh: 'p256',
    auth: 'auth',
  };

  beforeEach(() => {
    subscriptions = { getActiveForAddress: jest.fn() };
    dedup = {
      tryAcquire: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    };
    client = { isConfigured: jest.fn().mockReturnValue(true) };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    channel = new WebPushChannel(subscriptions, dedup, client, queue);
  });

  it('no-ops (no DB read) when VAPID is not configured', async () => {
    client.isConfigured.mockReturnValue(false);
    await channel.send(notifiable, notification);
    expect(subscriptions.getActiveForAddress).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('no-ops when the address has no subscriptions', async () => {
    subscriptions.getActiveForAddress.mockResolvedValue([]);
    await channel.send(notifiable, notification);
    expect(dedup.tryAcquire).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips enqueue when dedup says already handled', async () => {
    subscriptions.getActiveForAddress.mockResolvedValue([sub]);
    dedup.tryAcquire.mockResolvedValue(false);
    await channel.send(notifiable, notification);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('uses a channel-namespaced, PER-SUBSCRIPTION dedup key', async () => {
    subscriptions.getActiveForAddress.mockResolvedValue([sub]);
    dedup.tryAcquire.mockResolvedValue(false);
    await channel.send(notifiable, notification);
    // Namespaced by channel (can't collide with expo/database) AND by endpoint.
    expect(dedup.tryAcquire).toHaveBeenCalledWith(
      `web-push:invitation-claimed:th_1:ak_recipient:${sub.endpoint}`,
    );
  });

  it('enqueues one send job per subscription carrying the rendered payload', async () => {
    const sub2 = {
      endpoint: 'https://push.example/def',
      p256dh: 'p2',
      auth: 'a2',
    };
    subscriptions.getActiveForAddress.mockResolvedValue([sub, sub2]);
    dedup.tryAcquire.mockResolvedValue(true);

    await channel.send(notifiable, notification);

    expect(queue.add).toHaveBeenCalledTimes(2);
    const [job] = queue.add.mock.calls[0];
    expect(job).toEqual(
      expect.objectContaining({
        subscription: {
          endpoint: sub.endpoint,
          keys: { p256dh: 'p256', auth: 'auth' },
        },
        dedupKey: `web-push:invitation-claimed:th_1:ak_recipient:${sub.endpoint}`,
        payload: expect.objectContaining({ title: 'Invitation claimed' }),
      }),
    );
  });

  it('gives each subscription its OWN dedup key (no duplicate push to healthy devices)', async () => {
    // Regression: a SHARED key meant one dead endpoint exhausting its retries
    // released the marker for the whole address — so a re-observation re-pushed
    // to every other device. Keys must be endpoint-scoped so each device's
    // idempotency (and its release) is independent.
    const sub2 = {
      endpoint: 'https://push.example/def',
      p256dh: 'p2',
      auth: 'a2',
    };
    subscriptions.getActiveForAddress.mockResolvedValue([sub, sub2]);
    dedup.tryAcquire.mockResolvedValue(true);

    await channel.send(notifiable, notification);

    const keys = queue.add.mock.calls.map((c: any[]) => c[0].dedupKey);
    expect(new Set(keys).size).toBe(2); // distinct per endpoint
    expect(keys).toEqual([
      `web-push:invitation-claimed:th_1:ak_recipient:${sub.endpoint}`,
      `web-push:invitation-claimed:th_1:ak_recipient:${sub2.endpoint}`,
    ]);
  });

  it('skips only the already-delivered subscription, still pushing to the others', async () => {
    const sub2 = {
      endpoint: 'https://push.example/def',
      p256dh: 'p2',
      auth: 'a2',
    };
    subscriptions.getActiveForAddress.mockResolvedValue([sub, sub2]);
    // sub already has this notification; sub2 does not.
    dedup.tryAcquire.mockImplementation(async (key: string) =>
      key.endsWith(sub2.endpoint),
    );

    await channel.send(notifiable, notification);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][0].subscription.endpoint).toBe(
      sub2.endpoint,
    );
  });

  it('releases the dedup key and moves on to the next subscription when queue.add() fails', async () => {
    // Regression: a Redis/Bull blip on enqueue must not permanently suppress
    // this device's notification (nothing would ever release the marker
    // otherwise — the job never made it onto the queue, so the processor's own
    // retry-exhausted release path never runs), AND must not stop delivery to
    // this address's OTHER subscriptions.
    const sub2 = {
      endpoint: 'https://push.example/def',
      p256dh: 'p2',
      auth: 'a2',
    };
    subscriptions.getActiveForAddress.mockResolvedValue([sub, sub2]);
    dedup.tryAcquire.mockResolvedValue(true);
    queue.add
      .mockRejectedValueOnce(new Error('redis down')) // sub fails to enqueue
      .mockResolvedValueOnce(undefined); // sub2 still gets through

    await expect(
      channel.send(notifiable, notification),
    ).resolves.toBeUndefined();

    expect(dedup.release).toHaveBeenCalledWith(
      `web-push:invitation-claimed:th_1:ak_recipient:${sub.endpoint}`,
    );
    // Only ONE add() actually succeeded (sub2's); sub's failed attempt is not
    // itself a queued job.
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('still logs a warning (does not throw) even if the dedup release itself fails', async () => {
    subscriptions.getActiveForAddress.mockResolvedValue([sub]);
    dedup.tryAcquire.mockResolvedValue(true);
    queue.add.mockRejectedValue(new Error('redis down'));
    dedup.release.mockRejectedValue(new Error('redis still down'));

    await expect(
      channel.send(notifiable, notification),
    ).resolves.toBeUndefined();
  });

  it('throws when routed a notification that cannot render for the web copy', async () => {
    client.isConfigured.mockReturnValue(true);
    const noRenderer: any = {
      type: 'mystery',
      dedupKey: () => 'k',
      via: () => ['web-push'],
      toExpo: () => ({ title: 't', body: 'b' }),
      // no toDatabase
    };
    await expect(channel.send(notifiable, noRenderer)).rejects.toThrow(
      /no toDatabase/,
    );
  });
});

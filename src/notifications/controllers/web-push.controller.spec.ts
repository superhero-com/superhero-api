import { WebPushController } from './web-push.controller';

describe('WebPushController', () => {
  let subscriptions: any;
  let client: any;
  let controller: WebPushController;
  const address = 'ak_owner';

  beforeEach(() => {
    subscriptions = {
      upsert: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    client = { isConfigured: jest.fn().mockReturnValue(true) };
  });

  const make = (config: any) =>
    new WebPushController(subscriptions, client, config);

  it('returns the configured VAPID public key when the channel is configured', () => {
    controller = make({ vapidPublicKey: 'BPublicKey' });
    expect(controller.vapidPublicKey()).toEqual({ publicKey: 'BPublicKey' });
  });

  it('returns null when the public key env var is unset', () => {
    controller = make({ vapidPublicKey: undefined });
    expect(controller.vapidPublicKey()).toEqual({ publicKey: null });
  });

  it('returns null when the public key is set but the client is NOT configured (e.g. private key missing/malformed), so the frontend never subscribes against a dead channel', () => {
    client.isConfigured.mockReturnValue(false);
    controller = make({ vapidPublicKey: 'BPublicKey' });
    expect(controller.vapidPublicKey()).toEqual({ publicKey: null });
  });

  it('subscribes by upserting the browser subscription for the path address', async () => {
    controller = make({});
    const out = await controller.subscribe(address, {
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
      userAgent: 'Chrome',
    });
    expect(subscriptions.upsert).toHaveBeenCalledWith(address, {
      endpoint: 'https://push.example/abc',
      p256dh: 'p',
      auth: 'a',
      userAgent: 'Chrome',
    });
    expect(out).toEqual({ ok: true });
  });

  it('unsubscribes by endpoint scoped to the path address', async () => {
    controller = make({});
    const out = await controller.unsubscribe(address, {
      endpoint: 'https://push.example/abc',
    });
    expect(subscriptions.remove).toHaveBeenCalledWith(
      address,
      'https://push.example/abc',
    );
    expect(out).toEqual({ ok: true });
  });
});

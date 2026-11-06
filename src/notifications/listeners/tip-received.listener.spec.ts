import { NotificationGateService } from '../services/notification-gate.service';
import { TipReceivedListener } from './tip-received.listener';

describe('TipReceivedListener', () => {
  let notifications: any;
  let accountLabel: any;
  let redis: any;
  let preferences: any;
  let listener: TipReceivedListener;
  const config = {
    enabled: true,
    minAmountAettos: 0n,
    tipReceivedRateCap: 20,
    tipReceivedRateWindowSec: 3600,
  } as any;

  const payload = {
    senderAddress: 'ak_sender',
    receiverAddress: 'ak_receiver',
    amountAe: '2.5',
    amountAettos: '2500000000000000000',
    postId: '7_v3',
    txHash: 'th_tip',
  };

  const build = (cfg = config) =>
    new TipReceivedListener(
      notifications,
      accountLabel,
      new NotificationGateService(preferences, redis),
      cfg,
    );

  beforeEach(() => {
    notifications = { send: jest.fn().mockResolvedValue({ outcome: 'sent' }) };
    accountLabel = { labelFor: jest.fn().mockResolvedValue('alice.chain') };
    redis = {
      incrementWithCap: jest
        .fn()
        .mockResolvedValue({ capped: false, count: 1 }),
    };
    preferences = { isEnabled: jest.fn().mockResolvedValue(true) };
    listener = build();
  });

  it('notifies the receiver of a post tip on the web feed and browser push', async () => {
    await listener.onTipReceived(payload);
    expect(redis.incrementWithCap).toHaveBeenCalledWith(
      'notif:rate:tip-received:ak_receiver',
      3600,
      20,
    );
    expect(notifications.send).toHaveBeenCalledTimes(1);
    const [notifiable, notification] = notifications.send.mock.calls[0];
    expect(notifiable).toEqual({ address: 'ak_receiver' });
    expect(notification.type).toBe('tip-received');
    expect(notification.toExpo().body).toBe(
      'alice.chain tipped your post 2.5 AE',
    );
  });

  it('skips zero and sub-floor tips', async () => {
    await listener.onTipReceived({ ...payload, amountAettos: '0' });
    await listener.onTipReceived({ ...payload, amountAettos: 'garbage' });
    listener = build({
      ...config,
      minAmountAettos: 1_000_000_000_000_000_000n,
    });
    await listener.onTipReceived({
      ...payload,
      amountAettos: '999999999999999999',
    });
    expect(redis.incrementWithCap).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();

    await listener.onTipReceived({
      ...payload,
      amountAettos: '1000000000000000000',
    });
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('notifies a 1-aetto tip when no floor is configured', async () => {
    await listener.onTipReceived({ ...payload, amountAettos: '1' });
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('drops tips once the recipient is capped', async () => {
    redis.incrementWithCap.mockResolvedValue({ capped: true, count: 21 });
    await listener.onTipReceived(payload);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('respects the opt-out before spending rate budget', async () => {
    preferences.isEnabled.mockResolvedValue(false);
    await listener.onTipReceived(payload);
    expect(preferences.isEnabled).toHaveBeenCalledWith(
      'ak_receiver',
      'tip-received',
    );
    expect(redis.incrementWithCap).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('fails open when the rate-cap call throws (Redis down)', async () => {
    redis.incrementWithCap.mockRejectedValue(new Error('redis down'));
    await listener.onTipReceived(payload);
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('skips self tips, missing fields and the master switch', async () => {
    await listener.onTipReceived({
      ...payload,
      receiverAddress: 'ak_sender',
    });
    await listener.onTipReceived({ ...payload, txHash: '' });
    listener = build({ ...config, enabled: false });
    await listener.onTipReceived(payload);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('never throws back into the emitter', async () => {
    notifications.send.mockRejectedValue(new Error('boom'));
    await expect(listener.onTipReceived(payload)).resolves.toBeUndefined();
  });
});

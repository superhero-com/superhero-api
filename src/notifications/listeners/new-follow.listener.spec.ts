import { NewFollowListener } from './new-follow.listener';

describe('NewFollowListener', () => {
  let notifications: any;
  let accountLabel: any;
  let listener: NewFollowListener;
  const config = { enabled: true } as any;

  const payload = {
    followerAddress: 'ak_follower',
    followedAddress: 'ak_followed',
    txHash: 'th_follow',
  };

  beforeEach(() => {
    notifications = {
      send: jest.fn().mockResolvedValue({ outcome: 'sent' }),
    };
    accountLabel = { labelFor: jest.fn().mockResolvedValue('carol.chain') };
    listener = new NewFollowListener(notifications, accountLabel, config);
  });

  it('notifies the followed account, resolving the follower label', async () => {
    await listener.onFollowed(payload);
    expect(accountLabel.labelFor).toHaveBeenCalledWith(payload.followerAddress);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    const [notifiable, notification] = notifications.send.mock.calls[0];
    expect(notifiable).toEqual({ address: payload.followedAddress });
    expect(notification.type).toBe('new-follow');
    expect(notification.via()).toContain('database');
    expect(notification.toExpo().body).toBe(
      'carol.chain started following you',
    );
  });

  it('does not send when the notifications master switch is off', async () => {
    listener = new NewFollowListener(notifications, accountLabel, {
      enabled: false,
    } as any);
    await listener.onFollowed(payload);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('does not send on a self-follow', async () => {
    await listener.onFollowed({
      ...payload,
      followerAddress: payload.followedAddress,
    });
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('does not send when the payload is missing a party or tx hash', async () => {
    await listener.onFollowed({ ...payload, followedAddress: '' });
    await listener.onFollowed({ ...payload, txHash: '' });
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('swallows a send failure without throwing', async () => {
    notifications.send.mockResolvedValue({
      outcome: 'failed',
      channel: 'expo',
      error: 'boom',
    });
    await expect(listener.onFollowed(payload)).resolves.toBeUndefined();
  });
  it('propagates V2 delivery failures so the durable outbox can retry', async () => {
    notifications.send.mockResolvedValue({
      outcome: 'failed',
      error: 'temporary',
      channel: 'database',
    });
    await expect(
      listener.onFollowed({
        ...payload,
        graphScope: { network: 'ae_uat', contract: 'ct_v2', eventIndex: 2 },
      }),
    ).rejects.toThrow('temporary');
    await expect(listener.onFollowed(payload)).resolves.toBeUndefined();
  });
});

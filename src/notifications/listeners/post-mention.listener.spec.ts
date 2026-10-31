import { PostMentionListener } from './post-mention.listener';

describe('PostMentionListener', () => {
  let notifications: any;
  let accountLabel: any;
  let redis: any;
  let preferences: any;
  let listener: PostMentionListener;
  const config = {
    enabled: true,
    postMentionRateCap: 20,
    postMentionRateWindowSec: 3600,
  } as any;

  const payload = {
    authorAddress: 'ak_author',
    mentionedAddresses: ['ak_bob', 'ak_carol'],
    postId: '9_v3',
    txHash: 'th_post',
  };

  const build = (cfg = config) =>
    new PostMentionListener(
      notifications,
      accountLabel,
      redis,
      preferences,
      cfg,
    );

  beforeEach(() => {
    notifications = { send: jest.fn().mockResolvedValue({ outcome: 'sent' }) };
    accountLabel = { labelFor: jest.fn().mockResolvedValue('dave.chain') };
    redis = {
      incrementWithCap: jest
        .fn()
        .mockResolvedValue({ capped: false, count: 1 }),
    };
    preferences = { isEnabled: jest.fn().mockResolvedValue(true) };
    listener = build();
  });

  it('notifies every tagged account once, with the author label', async () => {
    await listener.onMentioned(payload);
    expect(notifications.send).toHaveBeenCalledTimes(2);
    expect(accountLabel.labelFor).toHaveBeenCalledTimes(1);
    const [notifiable, notification] = notifications.send.mock.calls[0];
    expect(notifiable).toEqual({ address: 'ak_bob' });
    expect(notification.type).toBe('post-mention');
    expect(notification.via()).toContain('database');
    expect(notification.toExpo().body).toBe(
      'dave.chain mentioned you in a post',
    );
    expect(notification.toDatabase().data).toMatchObject({
      author: 'ak_author',
      postId: '9_v3',
    });
    expect(notifications.send.mock.calls[1][0]).toEqual({
      address: 'ak_carol',
    });
  });

  it('skips the author, duplicates and the parent author of a comment', async () => {
    await listener.onMentioned({
      ...payload,
      mentionedAddresses: ['ak_author', 'ak_bob', 'ak_bob', 'ak_parent'],
      parentAuthorAddress: 'ak_parent',
    });
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send.mock.calls[0][0]).toEqual({ address: 'ak_bob' });
  });

  it('respects the opt-out before spending rate budget', async () => {
    preferences.isEnabled.mockImplementation(
      async (address: string) => address !== 'ak_bob',
    );
    await listener.onMentioned(payload);
    expect(redis.incrementWithCap).toHaveBeenCalledTimes(1);
    expect(redis.incrementWithCap.mock.calls[0][0]).toBe(
      'notif:rate:post-mention:ak_carol',
    );
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('drops capped recipients and fails open on Redis errors', async () => {
    redis.incrementWithCap
      .mockResolvedValueOnce({ capped: true, count: 21 })
      .mockRejectedValueOnce(new Error('redis down'));
    await listener.onMentioned(payload);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send.mock.calls[0][0]).toEqual({
      address: 'ak_carol',
    });
  });

  it('does nothing when disabled or with no recipients', async () => {
    await listener.onMentioned({ ...payload, mentionedAddresses: [] });
    listener = build({ ...config, enabled: false });
    await listener.onMentioned(payload);
    expect(notifications.send).not.toHaveBeenCalled();
  });
});

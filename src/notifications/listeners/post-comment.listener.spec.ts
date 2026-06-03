import { PostCommentListener } from './post-comment.listener';

describe('PostCommentListener', () => {
  let registry: any;
  let notifications: any;
  let accountLabel: any;
  let redis: any;
  let preferences: any;
  let listener: PostCommentListener;
  const config = {
    enabled: true,
    postCommentRateCap: 20,
    postCommentRateWindowSec: 3600,
  } as any;

  const payload = {
    commenterAddress: 'ak_commenter',
    postAuthorAddress: 'ak_author',
    parentPostId: 'p_parent',
    commentId: 'p_comment',
    txHash: 'th_x',
  };

  beforeEach(() => {
    registry = { hasDevices: jest.fn().mockResolvedValue(true) };
    notifications = {
      send: jest.fn().mockResolvedValue({ outcome: 'sent' }),
    };
    accountLabel = { labelFor: jest.fn().mockResolvedValue('bob.chain') };
    redis = {
      incrementWithCap: jest
        .fn()
        .mockResolvedValue({ count: 1, capped: false }),
    };
    preferences = { isEnabled: jest.fn().mockResolvedValue(true) };
    listener = new PostCommentListener(
      registry,
      notifications,
      accountLabel,
      redis,
      preferences,
      config,
    );
  });

  it('notifies the post author when under the rate cap', async () => {
    await listener.onCommented(payload);
    expect(preferences.isEnabled).toHaveBeenCalledWith(
      payload.postAuthorAddress,
      'post-comment',
    );
    expect(redis.incrementWithCap).toHaveBeenCalledWith(
      `notif:rate:post-comment:${payload.postAuthorAddress}`,
      3600,
      20,
    );
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('drops the dispatch when the per-recipient rate cap is hit', async () => {
    redis.incrementWithCap.mockResolvedValue({ count: 21, capped: true });
    await listener.onCommented(payload);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('does NOT increment the rate counter when the recipient has opted out', async () => {
    preferences.isEnabled.mockResolvedValue(false);
    await listener.onCommented(payload);
    expect(redis.incrementWithCap).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('skips when the recipient has no registered devices', async () => {
    registry.hasDevices.mockResolvedValue(false);
    await listener.onCommented(payload);
    expect(preferences.isEnabled).not.toHaveBeenCalled();
    expect(redis.incrementWithCap).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('skips self-comments', async () => {
    await listener.onCommented({
      ...payload,
      commenterAddress: payload.postAuthorAddress,
    });
    expect(registry.hasDevices).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('fails open when the rate-cap call throws (Redis down)', async () => {
    redis.incrementWithCap.mockRejectedValue(new Error('redis down'));
    await listener.onCommented(payload);
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('never throws back into the indexer when downstream fails', async () => {
    notifications.send.mockRejectedValue(new Error('boom'));
    await expect(listener.onCommented(payload)).resolves.toBeUndefined();
  });
});

import { NewFollowNotification } from './new-follow.notification';

describe('NewFollowNotification', () => {
  const base = {
    follower: 'ak_2followeraddressthatislong0000000000000000000000',
    followed: 'ak_followed',
    txHash: 'th_follow',
  };

  it('routes through the expo, database and web-push channels', () => {
    const n = new NewFollowNotification(base);
    expect(n.via()).toEqual(['expo', 'database', 'web-push']);
    expect(n.type).toBe('new-follow');
  });

  it('renders the same content for the database feed as for expo', () => {
    const n = new NewFollowNotification(base);
    expect(n.toDatabase()).toEqual(n.toExpo());
  });

  it('exposes catalog META mirrored onto the instance', () => {
    expect(NewFollowNotification.META.type).toBe('new-follow');
    const n = new NewFollowNotification(base);
    expect(n.title).toBe(NewFollowNotification.META.title);
    expect(n.description).toBe(NewFollowNotification.META.description);
  });

  it('builds a stable per-(tx,recipient) dedup key', () => {
    const n = new NewFollowNotification(base);
    expect(n.dedupKey({ address: 'ak_followed' as any })).toBe(
      'th_follow:ak_followed',
    );
  });

  it('renders the expo message with the follower label', () => {
    const n = new NewFollowNotification({
      ...base,
      followerLabel: 'carol.chain',
    });
    const msg = n.toExpo();
    expect(msg.title).toBe('New follower');
    expect(msg.body).toBe('carol.chain started following you');
    expect(msg.data).toMatchObject({
      type: 'new-follow',
      txHash: 'th_follow',
      follower: base.follower,
    });
  });

  it('falls back to a shortened address when no label is given', () => {
    const n = new NewFollowNotification(base);
    expect(n.toExpo().body).toContain('ak_2foll...0000');
  });
});

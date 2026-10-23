import { PostMentionNotification } from './post-mention.notification';

describe('PostMentionNotification', () => {
  const base = {
    mentioned: 'ak_mentioned',
    author: 'ak_2authoraddressthatislong000000000000000000000',
    postId: '9_v3',
    txHash: 'th_post',
  };

  it('routes through the expo, database and web-push channels', () => {
    const n = new PostMentionNotification(base);
    expect(n.via()).toEqual(['expo', 'database', 'web-push']);
    expect(n.type).toBe('post-mention');
  });

  it('renders the same content for the database feed as for expo', () => {
    const n = new PostMentionNotification(base);
    expect(n.toDatabase()).toEqual(n.toExpo());
  });

  it('exposes catalog META mirrored onto the instance', () => {
    expect(PostMentionNotification.META.type).toBe('post-mention');
    const n = new PostMentionNotification(base);
    expect(n.title).toBe(PostMentionNotification.META.title);
    expect(n.description).toBe(PostMentionNotification.META.description);
  });

  it('builds a stable per-(tx,recipient) dedup key', () => {
    const n = new PostMentionNotification(base);
    expect(n.dedupKey({ address: 'ak_mentioned' as any })).toBe(
      'th_post:ak_mentioned',
    );
  });

  it('renders the expo message with the author label', () => {
    const msg = new PostMentionNotification({
      ...base,
      authorLabel: 'dave.chain',
    }).toExpo();
    expect(msg.title).toBe('New mention');
    expect(msg.body).toBe('dave.chain mentioned you in a post');
    expect(msg.data).toEqual({
      type: 'post-mention',
      txHash: 'th_post',
      author: base.author,
      postId: '9_v3',
    });
  });

  it('falls back to a shortened address when no label is given', () => {
    const n = new PostMentionNotification(base);
    expect(n.toExpo().body).toBe('ak_2auth...0000 mentioned you in a post');
  });
});

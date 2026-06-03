import { PostCommentNotification } from './post-comment.notification';

describe('PostCommentNotification', () => {
  const base = {
    postAuthor: 'ak_author',
    commenter: 'ak_2commenteraddressthatislong00000000000000000000',
    parentPostId: 'p_parent',
    commentId: 'p_comment',
    txHash: 'th_comment',
  };

  it('routes through the expo channel', () => {
    const n = new PostCommentNotification(base);
    expect(n.via()).toEqual(['expo']);
    expect(n.type).toBe('post-comment');
  });

  it('exposes catalog META mirrored onto the instance', () => {
    expect(PostCommentNotification.META.type).toBe('post-comment');
    const n = new PostCommentNotification(base);
    expect(n.title).toBe(PostCommentNotification.META.title);
    expect(n.description).toBe(PostCommentNotification.META.description);
  });

  it('builds a stable per-(tx,recipient) dedup key', () => {
    const n = new PostCommentNotification(base);
    expect(n.dedupKey({ address: 'ak_author' as any })).toBe(
      'th_comment:ak_author',
    );
  });

  it('renders the expo message with commenter label', () => {
    const n = new PostCommentNotification({
      ...base,
      commenterLabel: 'carol.chain',
    });
    const msg = n.toExpo();
    expect(msg.title).toBe('New comment on your post');
    expect(msg.body).toBe('carol.chain commented on your post');
    expect(msg.data).toMatchObject({
      type: 'post-comment',
      txHash: 'th_comment',
      parentPostId: 'p_parent',
      commentId: 'p_comment',
    });
  });

  it('falls back to a shortened address when no label is given', () => {
    const n = new PostCommentNotification(base);
    expect(n.toExpo().body).toContain('ak_2comm...0000');
  });
});

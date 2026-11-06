import { TipReceivedNotification } from './tip-received.notification';

describe('TipReceivedNotification', () => {
  const base = {
    receiver: 'ak_receiver',
    sender: 'ak_2senderaddressthatislong000000000000000000000',
    amountAe: '2.5',
    postId: '7_v3',
    txHash: 'th_tip',
  };

  it('routes through the database and web-push channels only', () => {
    // Mobile already gets incoming-transfer for the same SpendTx.
    const n = new TipReceivedNotification(base);
    expect(n.via()).toEqual(['database', 'web-push']);
    expect(n.type).toBe('tip-received');
  });

  it('renders the same content for the database feed as for expo', () => {
    const n = new TipReceivedNotification(base);
    expect(n.toDatabase()).toEqual(n.toExpo());
  });

  it('exposes catalog META mirrored onto the instance', () => {
    expect(TipReceivedNotification.META.type).toBe('tip-received');
    const n = new TipReceivedNotification(base);
    expect(n.title).toBe(TipReceivedNotification.META.title);
    expect(n.description).toBe(TipReceivedNotification.META.description);
  });

  it('builds a stable per-(tx,recipient) dedup key', () => {
    const n = new TipReceivedNotification(base);
    expect(n.dedupKey({ address: 'ak_receiver' as any })).toBe(
      'th_tip:ak_receiver',
    );
  });

  it('renders a post tip with the sender label', () => {
    const msg = new TipReceivedNotification({
      ...base,
      senderLabel: 'alice.chain',
    }).toExpo();
    expect(msg.title).toBe('New tip');
    expect(msg.body).toBe('alice.chain tipped your post 2.5 AE');
    expect(msg.data).toEqual({
      type: 'tip-received',
      txHash: 'th_tip',
      sender: base.sender,
      amountAe: '2.5',
      postId: '7_v3',
    });
  });

  it('words a profile tip as tipping you, without a post link', () => {
    const msg = new TipReceivedNotification({
      ...base,
      postId: undefined,
      senderLabel: 'alice.chain',
    }).toExpo();
    expect(msg.body).toBe('alice.chain tipped you 2.5 AE');
    expect(msg.data).not.toHaveProperty('postId');
  });

  it('falls back to a shortened address when no label is given', () => {
    const n = new TipReceivedNotification(base);
    expect(n.toExpo().body).toBe('ak_2send...0000 tipped your post 2.5 AE');
  });
});

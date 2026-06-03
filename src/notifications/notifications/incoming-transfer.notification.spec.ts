import { IncomingTransferNotification } from './incoming-transfer.notification';

describe('IncomingTransferNotification', () => {
  const base = {
    recipient: 'ak_recipient',
    sender: 'ak_2senderaddressthatislong0000000000000000000000',
    amountAe: '2.5',
    txHash: 'th_abc',
  };

  it('routes through the expo channel', () => {
    const n = new IncomingTransferNotification(base);
    expect(n.via()).toEqual(['expo']);
    expect(n.type).toBe('incoming-transfer');
  });

  it('exposes catalog META mirrored onto the instance', () => {
    expect(IncomingTransferNotification.META).toEqual({
      type: 'incoming-transfer',
      title: 'Incoming transfers',
      description: 'Notifies you when someone sends you AE.',
    });
    const n = new IncomingTransferNotification(base);
    expect(n.type).toBe(IncomingTransferNotification.META.type);
    expect(n.title).toBe(IncomingTransferNotification.META.title);
    expect(n.description).toBe(IncomingTransferNotification.META.description);
  });

  it('builds a stable per-(tx,recipient) dedup key', () => {
    const n = new IncomingTransferNotification(base);
    expect(n.dedupKey({ address: 'ak_recipient' as any })).toBe(
      'th_abc:ak_recipient',
    );
  });

  it('renders the expo message with amount and sender label', () => {
    const n = new IncomingTransferNotification({
      ...base,
      senderLabel: 'alice.chain',
    });
    const msg = n.toExpo();
    expect(msg.title).toBe('Payment received');
    expect(msg.body).toBe('You received 2.5 AE from alice.chain');
    expect(msg.data).toMatchObject({
      type: 'incoming-transfer',
      txHash: 'th_abc',
      amountAe: '2.5',
    });
  });

  it('falls back to a shortened address when no label is given', () => {
    const n = new IncomingTransferNotification(base);
    const msg = n.toExpo();
    expect(msg.body).toContain('ak_2send...0000');
    expect(msg.body).not.toContain(base.sender);
  });
});

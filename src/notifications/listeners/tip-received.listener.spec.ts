import { TipReceivedListener } from './tip-received.listener';

describe('TipReceivedListener', () => {
  let notifications: any;
  let accountLabel: any;
  let listener: TipReceivedListener;

  const payload = {
    senderAddress: 'ak_sender',
    receiverAddress: 'ak_receiver',
    amountAe: '2.5',
    postId: '7_v3',
    txHash: 'th_tip',
  };

  beforeEach(() => {
    notifications = { send: jest.fn().mockResolvedValue({ outcome: 'sent' }) };
    accountLabel = { labelFor: jest.fn().mockResolvedValue('alice.chain') };
    listener = new TipReceivedListener(notifications, accountLabel, {
      enabled: true,
    } as any);
  });

  it('notifies the receiver of a post tip on the web feed and browser push', async () => {
    await listener.onTipReceived(payload);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    const [notifiable, notification] = notifications.send.mock.calls[0];
    expect(notifiable).toEqual({ address: 'ak_receiver' });
    expect(notification.type).toBe('tip-received');
    // Mobile already gets incoming-transfer for the same SpendTx.
    expect(notification.via()).toEqual(['database', 'web-push']);
    expect(notification.toExpo().body).toBe(
      'alice.chain tipped your post 2.5 AE',
    );
    expect(notification.toDatabase().data).toMatchObject({
      sender: 'ak_sender',
      postId: '7_v3',
    });
    expect(notification.dedupKey(notifiable)).toBe('th_tip:ak_receiver');
  });

  it('words a profile tip as tipping you', async () => {
    await listener.onTipReceived({ ...payload, postId: undefined });
    const [, notification] = notifications.send.mock.calls[0];
    expect(notification.toExpo().body).toBe('alice.chain tipped you 2.5 AE');
    expect(notification.toExpo().data.postId).toBeUndefined();
  });

  it('skips self tips, missing fields and the master switch', async () => {
    await listener.onTipReceived({
      ...payload,
      receiverAddress: 'ak_sender',
    });
    await listener.onTipReceived({ ...payload, txHash: '' });
    listener = new TipReceivedListener(notifications, accountLabel, {
      enabled: false,
    } as any);
    await listener.onTipReceived(payload);
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('never throws back into the emitter', async () => {
    notifications.send.mockRejectedValue(new Error('boom'));
    await expect(listener.onTipReceived(payload)).resolves.toBeUndefined();
  });
});

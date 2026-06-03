import { ExpoChannel } from './expo.channel';
import { IncomingTransferNotification } from '../notifications/incoming-transfer.notification';

describe('ExpoChannel', () => {
  let deviceService: any;
  let dedup: any;
  let queue: any;
  let channel: ExpoChannel;

  const config = { expoPushBatchSize: 100 } as any;
  const notifiable = { address: 'ak_recipient' as any };
  const notification = new IncomingTransferNotification({
    recipient: 'ak_recipient',
    sender: 'ak_sender',
    amountAe: '1',
    txHash: 'th_1',
  });

  beforeEach(() => {
    deviceService = { getActiveTokens: jest.fn() };
    dedup = { tryAcquire: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    channel = new ExpoChannel(deviceService, dedup, config, queue);
  });

  it('does nothing when the recipient has no devices', async () => {
    deviceService.getActiveTokens.mockResolvedValue([]);
    await channel.send(notifiable, notification);
    expect(dedup.tryAcquire).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does nothing when dedup says the notification was already handled', async () => {
    deviceService.getActiveTokens.mockResolvedValue(['t1']);
    dedup.tryAcquire.mockResolvedValue(false);
    await channel.send(notifiable, notification);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('enqueues a single Expo send job when tokens fit in one chunk', async () => {
    deviceService.getActiveTokens.mockResolvedValue(['t1', 't2']);
    dedup.tryAcquire.mockResolvedValue(true);

    await channel.send(notifiable, notification);

    expect(dedup.tryAcquire).toHaveBeenCalledWith(
      'incoming-transfer:th_1:ak_recipient',
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ['t1', 't2'],
        content: expect.objectContaining({ title: 'Payment received' }),
      }),
      expect.objectContaining({ attempts: 5 }),
    );
  });

  it('enqueues one job per chunk so retries do not re-send earlier chunks', async () => {
    const small = { ...config, expoPushBatchSize: 2 } as any;
    channel = new ExpoChannel(deviceService, dedup, small, queue);

    deviceService.getActiveTokens.mockResolvedValue([
      't1',
      't2',
      't3',
      't4',
      't5',
    ]);
    dedup.tryAcquire.mockResolvedValue(true);

    await channel.send(notifiable, notification);

    expect(queue.add).toHaveBeenCalledTimes(3);
    expect(queue.add.mock.calls[0][0].tokens).toEqual(['t1', 't2']);
    expect(queue.add.mock.calls[1][0].tokens).toEqual(['t3', 't4']);
    expect(queue.add.mock.calls[2][0].tokens).toEqual(['t5']);
  });
});

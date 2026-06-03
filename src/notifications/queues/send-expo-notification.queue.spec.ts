import { SendExpoNotificationQueue } from './send-expo-notification.queue';
import { isExpoPushToken } from '../expo/expo-push.client';

describe('SendExpoNotificationQueue', () => {
  let expo: any;
  let deviceService: any;
  let redis: any;
  let dedup: any;
  let receiptQueue: any;
  let processor: SendExpoNotificationQueue;
  const config = { receiptDelayMs: 900_000 } as any;

  const content = { title: 'Payment received', body: 'You received 1 AE' };
  const DEDUP_KEY = 'incoming-transfer:tx1:ak_alice';
  const job = (
    tokens: string[],
    opts: { attemptsMade?: number; attempts?: number } = {},
  ) =>
    ({
      data: { tokens, content, dedupKey: DEDUP_KEY },
      attemptsMade: opts.attemptsMade ?? 0,
      opts: { attempts: opts.attempts ?? 5 },
    }) as any;

  beforeEach(() => {
    expo = {
      isExpoPushToken: (t: string) => isExpoPushToken(t),
      sendPushNotificationsAsync: jest.fn(),
    };
    deviceService = { pruneToken: jest.fn().mockResolvedValue(undefined) };
    redis = { setEx: jest.fn().mockResolvedValue(undefined) };
    dedup = { release: jest.fn().mockResolvedValue(undefined) };
    receiptQueue = { add: jest.fn().mockResolvedValue(undefined) };
    processor = new SendExpoNotificationQueue(
      expo,
      deviceService,
      redis,
      dedup,
      config,
      receiptQueue,
    );
  });

  it('sends to valid tokens, records tickets and schedules a receipt check', async () => {
    expo.sendPushNotificationsAsync.mockResolvedValue([
      { status: 'ok', id: 'r1' },
      { status: 'ok', id: 'r2' },
    ]);

    await processor.process(
      job(['ExponentPushToken[a]', 'ExponentPushToken[b]']),
    );

    expect(expo.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(redis.setEx).toHaveBeenCalledTimes(2);
    expect(receiptQueue.add).toHaveBeenCalledWith(
      { ticketIds: ['r1', 'r2'] },
      expect.objectContaining({ delay: 900_000 }),
    );
  });

  it('prunes tokens that Expo reports as DeviceNotRegistered', async () => {
    expo.sendPushNotificationsAsync.mockResolvedValue([
      {
        status: 'error',
        message: 'gone',
        details: { error: 'DeviceNotRegistered' },
      },
    ]);

    await processor.process(job(['ExponentPushToken[dead]']));

    expect(deviceService.pruneToken).toHaveBeenCalledWith(
      'ExponentPushToken[dead]',
    );
    expect(receiptQueue.add).not.toHaveBeenCalled();
  });

  it('drops syntactically invalid tokens before sending', async () => {
    await processor.process(job(['not-a-token']));
    expect(expo.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('releases the dedup key when the send exhausts its retries (final attempt)', async () => {
    expo.sendPushNotificationsAsync.mockRejectedValue(new Error('expo 500'));
    await expect(
      processor.process(
        job(['ExponentPushToken[a]'], { attemptsMade: 4, attempts: 5 }),
      ),
    ).rejects.toThrow('expo 500');
    // Marker dropped so a later re-observation can re-deliver.
    expect(dedup.release).toHaveBeenCalledWith(DEDUP_KEY);
  });

  it('keeps the dedup key on a non-final attempt so Bull retries without double-sending', async () => {
    expo.sendPushNotificationsAsync.mockRejectedValue(new Error('expo 500'));
    await expect(
      processor.process(
        job(['ExponentPushToken[a]'], { attemptsMade: 0, attempts: 5 }),
      ),
    ).rejects.toThrow('expo 500');
    expect(dedup.release).not.toHaveBeenCalled();
  });
});

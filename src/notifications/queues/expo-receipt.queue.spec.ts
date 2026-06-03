import { ExpoReceiptQueue } from './expo-receipt.queue';
import { REDIS_KEYS } from '../notifications.constants';

/**
 * Covers the primary dead-token pruning path: a DeviceNotRegistered delivery
 * receipt prunes the token its ticket mapped to, and every ticket->token key
 * is cleaned up afterward.
 */
describe('ExpoReceiptQueue', () => {
  let expo: any;
  let deviceService: any;
  let redis: any;
  let processor: ExpoReceiptQueue;

  const job = (ticketIds: string[]) => ({ data: { ticketIds } }) as any;

  beforeEach(() => {
    expo = {
      chunkReceiptIds: (ids: string[]) => [ids],
      getPushNotificationReceiptsAsync: jest.fn(),
    };
    deviceService = { pruneToken: jest.fn().mockResolvedValue(undefined) };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(undefined),
    };
    processor = new ExpoReceiptQueue(expo, deviceService, redis);
  });

  it('prunes the mapped token on a DeviceNotRegistered receipt and clears the key', async () => {
    expo.getPushNotificationReceiptsAsync.mockResolvedValue({
      r1: { status: 'error', details: { error: 'DeviceNotRegistered' } },
    });
    redis.get.mockResolvedValue('ExponentPushToken[dead]');

    await processor.process(job(['r1']));

    expect(redis.get).toHaveBeenCalledWith(REDIS_KEYS.ticketToken('r1'));
    expect(deviceService.pruneToken).toHaveBeenCalledWith(
      'ExponentPushToken[dead]',
    );
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEYS.ticketToken('r1'));
  });

  it('does not prune on an ok receipt but still clears the mapping key', async () => {
    expo.getPushNotificationReceiptsAsync.mockResolvedValue({
      r2: { status: 'ok' },
    });

    await processor.process(job(['r2']));

    expect(deviceService.pruneToken).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEYS.ticketToken('r2'));
  });

  it('does not prune when the ticket->token mapping has already expired', async () => {
    expo.getPushNotificationReceiptsAsync.mockResolvedValue({
      r3: { status: 'error', details: { error: 'DeviceNotRegistered' } },
    });
    redis.get.mockResolvedValue(null); // key lapsed

    await processor.process(job(['r3']));

    expect(deviceService.pruneToken).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEYS.ticketToken('r3'));
  });

  it('does not prune on a non-DeviceNotRegistered error (only logs)', async () => {
    expo.getPushNotificationReceiptsAsync.mockResolvedValue({
      r4: { status: 'error', message: 'MessageRateExceeded' },
    });

    await processor.process(job(['r4']));

    expect(deviceService.pruneToken).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEYS.ticketToken('r4'));
  });
});

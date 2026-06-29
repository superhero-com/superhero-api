import type { Job } from 'bull';
import { RoomMessageNotification } from '../../notifications/room-message.notification';
import { RoomMessageNotifyProcessor } from '../room-message-notify.processor';
import type { RoomMessageNotifyJob } from '../room-message-notify.types';

const SALE = 'ct_msg_sale';
const RECIPIENT = 'ak_recipient';

function makeProcessor(
  over: {
    getActiveTokens?: jest.Mock;
    isRoomEnabled?: jest.Mock;
    send?: jest.Mock;
    findToken?: jest.Mock;
  } = {},
) {
  const getActiveTokens =
    over.getActiveTokens ??
    jest.fn().mockResolvedValue(['ExponentPushToken[x]']);
  const isRoomEnabled = over.isRoomEnabled ?? jest.fn().mockResolvedValue(true);
  const send = over.send ?? jest.fn().mockResolvedValue({ outcome: 'sent' });
  const findToken =
    over.findToken ??
    jest.fn().mockResolvedValue({ sale_address: SALE, symbol: 'FRESH' });

  const tokenRepo = { findOne: findToken } as any;
  const devices = { getActiveTokens } as any;
  const roomPreferences = { isRoomEnabled } as any;
  const notifications = { send } as any;

  const processor = new RoomMessageNotifyProcessor(
    tokenRepo,
    devices,
    roomPreferences,
    notifications,
  );
  return { processor, getActiveTokens, isRoomEnabled, send, findToken };
}

function job(
  over: Partial<RoomMessageNotifyJob> = {},
): Job<RoomMessageNotifyJob> {
  return {
    data: {
      sale_address: SALE,
      recipient: RECIPIENT,
      symbol: 'QUEUED',
      message_count: 3,
      window_started_at: 1700000000,
      sample_event_id: 'evt1',
      ...over,
    },
  } as Job<RoomMessageNotifyJob>;
}

describe('RoomMessageNotifyProcessor', () => {
  it('dispatches a RoomMessageNotification when a device exists and not muted', async () => {
    const { processor, send } = makeProcessor();
    await processor.process(job());
    expect(send).toHaveBeenCalledTimes(1);
    const [notifiable, notification] = send.mock.calls[0];
    expect(notifiable).toEqual({ address: RECIPIENT });
    expect(notification).toBeInstanceOf(RoomMessageNotification);
    expect(notification.type).toBe('room-messages');
    expect(notification.toExpo().data).toMatchObject({
      type: 'room-messages',
      saleAddress: SALE,
    });
  });

  it('re-resolves the room symbol (prefers DB over the queued snapshot)', async () => {
    const { processor, send } = makeProcessor();
    await processor.process(job({ symbol: 'STALE' }));
    const notification = send.mock.calls[0][1] as RoomMessageNotification;
    // FRESH (from findOne) wins over the queued STALE.
    expect(notification.toExpo().body).toContain('FRESH');
  });

  it('falls back to the queued symbol when the token is gone', async () => {
    const { processor, send } = makeProcessor({
      findToken: jest.fn().mockResolvedValue(null),
    });
    await processor.process(job({ symbol: 'QUEUED' }));
    const notification = send.mock.calls[0][1] as RoomMessageNotification;
    expect(notification.toExpo().body).toContain('QUEUED');
  });

  it('keys the dedup key off the coalescing window', async () => {
    const { processor, send } = makeProcessor();
    await processor.process(job({ window_started_at: 1700000123 }));
    const notification = send.mock.calls[0][1] as RoomMessageNotification;
    expect(notification.dedupKey({ address: RECIPIENT as any })).toBe(
      `room-messages:${SALE}:${RECIPIENT}:w1700000123`,
    );
  });

  it('SKIPs when the recipient has no registered device', async () => {
    const { processor, send } = makeProcessor({
      getActiveTokens: jest.fn().mockResolvedValue([]),
    });
    await processor.process(job());
    expect(send).not.toHaveBeenCalled();
  });

  it('SKIPs when room-scoped mute is on (per-room or type-level)', async () => {
    const { processor, send } = makeProcessor({
      isRoomEnabled: jest.fn().mockResolvedValue(false),
    });
    await processor.process(job());
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a malformed payload (missing keys)', async () => {
    const { processor, send } = makeProcessor();
    await processor.process({ data: {} } as Job<RoomMessageNotifyJob>);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not throw on a failed SendOutcome (logs only)', async () => {
    const { processor, send } = makeProcessor({
      send: jest.fn().mockResolvedValue({
        outcome: 'failed',
        channel: 'expo',
        error: 'boom',
      }),
    });
    await expect(processor.process(job())).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

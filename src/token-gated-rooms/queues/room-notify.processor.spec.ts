import type { Job } from 'bull';
import { RoomNotifyProcessor } from './room-notify.processor';
import { RoomMembershipNotification } from '../notifications/room-membership.notification';
import type { RoomNotifyJob } from './room-notify.types';

describe('RoomNotifyProcessor', () => {
  const SALE = 'ct_sale';
  const MEMBER = 'ak_member';

  let tokenRepo: { findOne: jest.Mock };
  let devices: { getActiveTokens: jest.Mock };
  let roomPreferences: { isRoomEnabled: jest.Mock };
  let notifications: { send: jest.Mock };
  let processor: RoomNotifyProcessor;

  const job = (over: Partial<RoomNotifyJob> = {}): Job<RoomNotifyJob> =>
    ({
      data: {
        saleAddress: SALE,
        memberAddress: MEMBER,
        change: 'added',
        ...over,
      },
    }) as Job<RoomNotifyJob>;

  beforeEach(() => {
    tokenRepo = { findOne: jest.fn().mockResolvedValue({ symbol: 'FOO' }) };
    devices = {
      getActiveTokens: jest.fn().mockResolvedValue(['ExponentPushToken[x]']),
    };
    roomPreferences = { isRoomEnabled: jest.fn().mockResolvedValue(true) };
    notifications = { send: jest.fn().mockResolvedValue({ outcome: 'sent' }) };
    processor = new RoomNotifyProcessor(
      tokenRepo as any,
      devices as any,
      roomPreferences as any,
      notifications as any,
    );
  });

  it('dispatches an added RoomMembershipNotification on the happy path', async () => {
    await processor.process(job());
    expect(devices.getActiveTokens).toHaveBeenCalledWith(MEMBER);
    expect(roomPreferences.isRoomEnabled).toHaveBeenCalledWith(
      MEMBER,
      RoomMembershipNotification.META.type,
      SALE,
    );
    expect(notifications.send).toHaveBeenCalledTimes(1);
    const [notifiable, notification] = notifications.send.mock.calls[0];
    expect(notifiable).toEqual({ address: MEMBER });
    expect(notification).toBeInstanceOf(RoomMembershipNotification);
    expect(notification.toExpo().data).toMatchObject({
      change: 'added',
      saleAddress: SALE,
    });
  });

  it('SKIPS dispatch when the member has no registered device', async () => {
    devices.getActiveTokens.mockResolvedValue([]);
    await processor.process(job());
    expect(roomPreferences.isRoomEnabled).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('SKIPS dispatch when per-room/type muted (isRoomEnabled=false)', async () => {
    roomPreferences.isRoomEnabled.mockResolvedValue(false);
    await processor.process(job());
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('resolves and forwards the room symbol into the notification copy', async () => {
    await processor.process(job());
    const notification = notifications.send.mock.calls[0][1];
    expect(notification.toExpo().body).toContain('FOO');
  });

  it('still dispatches with generic copy when the symbol lookup fails', async () => {
    tokenRepo.findOne.mockRejectedValue(new Error('db'));
    await processor.process(job());
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send.mock.calls[0][1].toExpo().body).toContain(
      'a room',
    );
  });

  it('ignores malformed jobs', async () => {
    await processor.process(job({ memberAddress: '' as any }));
    expect(notifications.send).not.toHaveBeenCalled();
  });
});

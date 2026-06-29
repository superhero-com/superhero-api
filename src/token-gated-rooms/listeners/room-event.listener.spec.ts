import { RoomEventListener } from './room-event.listener';
import type { TgrMembershipChangedPayload } from '../events';

describe('RoomEventListener', () => {
  const SALE = 'ct_sale';
  const MEMBER = 'ak_member';

  let queue: { add: jest.Mock; getJobCounts: jest.Mock };
  let redis: { tryAcquire: jest.Mock; incrementWithCap: jest.Mock };
  let tgr: any;
  let notifications: any;
  let listener: RoomEventListener;

  const added: TgrMembershipChangedPayload = {
    saleAddress: SALE,
    memberAddress: MEMBER,
    relayState: 'added',
  };

  beforeEach(() => {
    queue = {
      add: jest.fn().mockResolvedValue({ id: 'j1' }),
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, delayed: 0 }),
    };
    redis = {
      tryAcquire: jest.fn().mockResolvedValue(true),
      incrementWithCap: jest
        .fn()
        .mockResolvedValue({ count: 1, capped: false }),
    };
    tgr = {
      roomNotifyDepthBreak: 10000,
      msgCoalesceWindowSec: 60,
      msgRateCap: 0,
    };
    notifications = { enabled: true };
    listener = new RoomEventListener(
      queue as any,
      redis as any,
      tgr,
      notifications,
    );
  });

  it('enqueues an "added" room-notify job on a relay_state=added event', async () => {
    await listener.onMembershipChanged(added);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][0]).toEqual({
      saleAddress: SALE,
      memberAddress: MEMBER,
      change: 'added',
    });
  });

  it('maps relay_state=removed and pending_remove to a "removed" job', async () => {
    await listener.onMembershipChanged({
      saleAddress: SALE,
      memberAddress: MEMBER,
      relayState: 'removed',
    });
    expect(queue.add.mock.calls[0][0].change).toBe('removed');

    queue.add.mockClear();
    redis.tryAcquire.mockResolvedValue(true);
    await listener.onMembershipChanged({
      saleAddress: SALE,
      memberAddress: MEMBER,
      relayState: 'pending_remove',
    });
    expect(queue.add.mock.calls[0][0].change).toBe('removed');
  });

  it('ignores non-membership relay states (pending_add — role/in-flight)', async () => {
    await listener.onMembershipChanged({
      saleAddress: SALE,
      memberAddress: MEMBER,
      relayState: 'pending_add',
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does nothing when notifications are disabled', async () => {
    notifications.enabled = false;
    await listener.onMembershipChanged(added);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('ignores payloads missing sale/member', async () => {
    await listener.onMembershipChanged({ relayState: 'added' } as any);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('drops the push when the room-notify queue is over the depth break', async () => {
    queue.getJobCounts.mockResolvedValue({ waiting: 9999, delayed: 1 });
    await listener.onMembershipChanged(added);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('coalesces repeated (sale, member, change) within the window', async () => {
    // Second tryAcquire returns false → coalesced (no enqueue).
    redis.tryAcquire.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await listener.onMembershipChanged(added);
    await listener.onMembershipChanged(added);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('skips coalescing entirely when the window is 0', async () => {
    tgr.msgCoalesceWindowSec = 0;
    await listener.onMembershipChanged(added);
    expect(redis.tryAcquire).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('drops when the per-recipient rate cap is hit (when configured)', async () => {
    tgr.msgRateCap = 5;
    redis.incrementWithCap.mockResolvedValue({ count: 6, capped: true });
    await listener.onMembershipChanged(added);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not apply the rate cap when msgRateCap=0 (default off)', async () => {
    tgr.msgRateCap = 0;
    await listener.onMembershipChanged(added);
    expect(redis.incrementWithCap).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('fails open on a coalesce Redis error (still enqueues)', async () => {
    redis.tryAcquire.mockRejectedValue(new Error('redis down'));
    await listener.onMembershipChanged(added);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('never throws back into the emitter (swallows enqueue errors)', async () => {
    queue.add.mockRejectedValue(new Error('bull down'));
    await expect(listener.onMembershipChanged(added)).resolves.toBeUndefined();
  });
});

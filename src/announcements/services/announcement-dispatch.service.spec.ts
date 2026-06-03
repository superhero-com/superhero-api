import { AnnouncementDispatchService } from './announcement-dispatch.service';
import { Announcement } from '../entities/announcement.entity';

const FIXTURE_TOKEN = 'fixture-token-uuid';

function makeAnnouncement(partial: Partial<Announcement>): Announcement {
  return {
    id: 1,
    title: 'Hello',
    description: 'World',
    scheduled_at: new Date(),
    target_type: 'all',
    feed_visible: true,
    claimed_at: new Date(),
    claim_token: FIXTURE_TOKEN,
    attempt_count: 0,
    processed_at: null,
    recipient_count: null,
    delivered_count: null,
    opted_out_count: null,
    no_channel_count: null,
    failed_count: null,
    error: null,
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...partial,
  } as Announcement;
}

describe('AnnouncementDispatchService', () => {
  const config = {
    enabled: true,
    fanoutBatch: 2,
    staleClaimMs: 300_000,
  } as any;

  function setup() {
    const announcements = {
      addressesFor: jest.fn(),
      markCompleted: jest.fn().mockResolvedValue(true),
      heartbeatClaim: jest.fn().mockResolvedValue(true),
    };
    const deviceService = {
      distinctAddressesWithDevice: jest.fn(),
    };
    const notifications = {
      send: jest.fn().mockResolvedValue({ outcome: 'sent' }),
    };
    const service = new AnnouncementDispatchService(
      announcements as any,
      deviceService as any,
      notifications as any,
      config,
    );
    return { service, announcements, deviceService, notifications };
  }

  it("resolves 'all' from registered devices and counts each as delivered", async () => {
    const { service, announcements, deviceService, notifications } = setup();
    deviceService.distinctAddressesWithDevice.mockResolvedValue([
      'ak_a',
      'ak_b',
      'ak_c',
    ]);

    await service.run(makeAnnouncement({ id: 7, target_type: 'all' }));

    expect(deviceService.distinctAddressesWithDevice).toHaveBeenCalledTimes(1);
    expect(announcements.addressesFor).not.toHaveBeenCalled();
    expect(notifications.send).toHaveBeenCalledTimes(3);
    expect(announcements.markCompleted).toHaveBeenCalledWith(7, FIXTURE_TOKEN, {
      recipientCount: 3,
      deliveredCount: 3,
      optedOutCount: 0,
      noChannelCount: 0,
      failedCount: 0,
      error: undefined,
    });
  });

  it('separates opted-out from delivered in the counters', async () => {
    const { service, announcements, deviceService, notifications } = setup();
    deviceService.distinctAddressesWithDevice.mockResolvedValue([
      'ak_a',
      'ak_b',
      'ak_c',
    ]);
    notifications.send
      .mockResolvedValueOnce({ outcome: 'sent' })
      .mockResolvedValueOnce({ outcome: 'opted-out' })
      .mockResolvedValueOnce({ outcome: 'sent' });

    await service.run(makeAnnouncement({ id: 8, target_type: 'all' }));

    expect(announcements.markCompleted).toHaveBeenCalledWith(8, FIXTURE_TOKEN, {
      recipientCount: 3,
      deliveredCount: 2,
      optedOutCount: 1,
      noChannelCount: 0,
      failedCount: 0,
      error: undefined,
    });
  });

  it('counts no-channel outcomes into noChannelCount, NOT failedCount', async () => {
    const { service, announcements, deviceService, notifications } = setup();
    deviceService.distinctAddressesWithDevice.mockResolvedValue([
      'ak_a',
      'ak_b',
      'ak_c',
    ]);
    notifications.send
      .mockResolvedValueOnce({ outcome: 'sent' })
      .mockResolvedValueOnce({ outcome: 'no-channel' })
      .mockResolvedValueOnce({ outcome: 'no-channel' });

    await service.run(makeAnnouncement({ id: 11, target_type: 'all' }));

    expect(announcements.markCompleted).toHaveBeenCalledWith(
      11,
      FIXTURE_TOKEN,
      {
        recipientCount: 3,
        deliveredCount: 1,
        optedOutCount: 0,
        noChannelCount: 2,
        failedCount: 0,
        error: undefined,
      },
    );
  });

  it('records channel failures as failed_count + first error message', async () => {
    const { service, announcements, deviceService, notifications } = setup();
    deviceService.distinctAddressesWithDevice.mockResolvedValue([
      'ak_a',
      'ak_b',
    ]);
    notifications.send
      .mockResolvedValueOnce({
        outcome: 'failed',
        channel: 'expo',
        error: 'expo down',
      })
      .mockResolvedValueOnce({ outcome: 'sent' });

    await service.run(makeAnnouncement({ id: 9, target_type: 'all' }));

    expect(announcements.markCompleted).toHaveBeenCalledWith(9, FIXTURE_TOKEN, {
      recipientCount: 2,
      deliveredCount: 1,
      optedOutCount: 0,
      noChannelCount: 0,
      failedCount: 1,
      error: 'expo down',
    });
  });

  it("resolves 'specific' from the targets table", async () => {
    const { service, announcements, deviceService, notifications } = setup();
    announcements.addressesFor.mockResolvedValue(['ak_x']);

    await service.run(makeAnnouncement({ id: 10, target_type: 'specific' }));

    expect(announcements.addressesFor).toHaveBeenCalledWith(10);
    expect(deviceService.distinctAddressesWithDevice).not.toHaveBeenCalled();
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(announcements.markCompleted).toHaveBeenCalledWith(
      10,
      FIXTURE_TOKEN,
      {
        recipientCount: 1,
        deliveredCount: 1,
        optedOutCount: 0,
        noChannelCount: 0,
        failedCount: 0,
        error: undefined,
      },
    );
  });

  it('aborts cleanly and skips markCompleted when heartbeatClaim returns false (peer took over)', async () => {
    const { service, announcements, deviceService, notifications } = setup();
    // 12 addresses + fanoutBatch=2 → 6 batches. The heartbeat fires at
    // batchIdx % 5 === 4 when there is at least one more batch — i.e. before
    // batch 5 (after the 5th batch finishes). Return false at that point to
    // simulate a peer taking over after our claim went stale.
    const addresses = Array.from({ length: 12 }, (_, i) => `ak_${i}`);
    deviceService.distinctAddressesWithDevice.mockResolvedValue(addresses);
    announcements.heartbeatClaim.mockResolvedValue(false);

    await service.run(makeAnnouncement({ id: 99, target_type: 'all' }));

    // Heartbeat fired (and returned false) — dispatch aborted before the
    // remaining batches and before the terminal markCompleted call.
    expect(announcements.heartbeatClaim).toHaveBeenCalledWith(
      99,
      FIXTURE_TOKEN,
    );
    expect(announcements.markCompleted).not.toHaveBeenCalled();
    // We did send to the batches we processed before the heartbeat fired,
    // but we did NOT send to every address — the peer will finish the rest.
    expect(notifications.send.mock.calls.length).toBeLessThan(addresses.length);
  });

  it('aborts when the row has no claim_token (defensive guard)', async () => {
    const { service, announcements, notifications } = setup();
    await service.run(makeAnnouncement({ id: 100, claim_token: null }));
    expect(notifications.send).not.toHaveBeenCalled();
    expect(announcements.markCompleted).not.toHaveBeenCalled();
  });

  it('re-throws (does NOT mark completed) when recipient resolution fails, so the scheduler retries', async () => {
    const { service, announcements, deviceService, notifications } = setup();
    deviceService.distinctAddressesWithDevice.mockRejectedValue(
      new Error('db down'),
    );

    // A transient resolution failure must propagate to the scheduler's crash
    // path (releaseClaim + attempt_count cap), not be swallowed as a completed
    // row with zero counters — that would permanently drop the announcement.
    await expect(
      service.run(makeAnnouncement({ id: 5, target_type: 'all' })),
    ).rejects.toThrow('db down');

    expect(notifications.send).not.toHaveBeenCalled();
    expect(announcements.markCompleted).not.toHaveBeenCalled();
  });
});

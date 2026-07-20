import { DatabaseChannel } from './database.channel';
import { InvitationClaimedNotification } from '../notifications/invitation-claimed.notification';

describe('DatabaseChannel', () => {
  let feed: any;
  let dedup: any;
  let gateway: any;
  let channel: DatabaseChannel;

  const notifiable = { address: 'ak_recipient' as any };
  // A web-eligible type (via() includes 'database' and it implements toDatabase).
  const notification = new InvitationClaimedNotification({
    inviter: 'ak_recipient',
    claimer: 'ak_claimer',
    amountAe: '1',
    txHash: 'th_1',
  });

  const recordFixture = (over: Partial<any> = {}) => ({
    id: 7,
    type: 'invitation-claimed',
    title: 'Invitation claimed',
    body: 'ak_claim... just claimed your invitation for 1 AE',
    data: { type: 'invitation-claimed', txHash: 'th_1' },
    read_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  beforeEach(() => {
    feed = { recordAndCountUnread: jest.fn() };
    dedup = {
      tryAcquire: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    };
    gateway = { emitToAddress: jest.fn(), emitUnreadCount: jest.fn() };
    channel = new DatabaseChannel(feed, dedup, gateway);
  });

  it('does nothing when dedup says the notification was already handled', async () => {
    dedup.tryAcquire.mockResolvedValue(false);
    await channel.send(notifiable, notification);
    expect(feed.recordAndCountUnread).not.toHaveBeenCalled();
    expect(gateway.emitToAddress).not.toHaveBeenCalled();
  });

  it('uses a channel-namespaced dedup key so it cannot collide with Expo', async () => {
    dedup.tryAcquire.mockResolvedValue(false);
    await channel.send(notifiable, notification);
    expect(dedup.tryAcquire).toHaveBeenCalledWith(
      'database:invitation-claimed:th_1:ak_recipient',
    );
  });

  it('persists the row (with the unread count from the SAME call) then emits both live', async () => {
    // Regression: a SEPARATE record() + unreadCount() pair has an await gap
    // between the write and the read, during which a concurrent markRead()
    // can complete its own write+emit — so this call's independently-read
    // count could be stale by the time it's finally emitted, overwriting
    // markRead's correct badge with a wrong, higher value. Fetching both from
    // ONE combined call (recordAndCountUnread) closes that window: there is no
    // separate awaited read to go stale.
    dedup.tryAcquire.mockResolvedValue(true);
    feed.recordAndCountUnread.mockResolvedValue({
      record: recordFixture({ id: 7 }),
      unreadCount: 4,
    });

    await channel.send(notifiable, notification);

    expect(feed.recordAndCountUnread).toHaveBeenCalledWith(
      'ak_recipient',
      'invitation-claimed',
      expect.objectContaining({ title: 'Invitation claimed' }),
    );
    expect(feed.recordAndCountUnread).toHaveBeenCalledTimes(1); // one round-trip
    expect(gateway.emitToAddress).toHaveBeenCalledWith(
      'ak_recipient',
      expect.objectContaining({ id: 7, read_at: null }),
    );
    expect(gateway.emitUnreadCount).toHaveBeenCalledWith('ak_recipient', 4);
  });

  it('does not fail the channel when the live emit throws (row already persisted)', async () => {
    dedup.tryAcquire.mockResolvedValue(true);
    feed.recordAndCountUnread.mockResolvedValue({
      record: recordFixture({ id: 8 }),
      unreadCount: 1,
    });
    gateway.emitToAddress.mockImplementation(() => {
      throw new Error('socket boom');
    });

    await expect(
      channel.send(notifiable, notification),
    ).resolves.toBeUndefined();
    expect(feed.recordAndCountUnread).toHaveBeenCalled();
    // The socket path is already broken this tick — the badge push is skipped
    // too (both are best-effort; the next refresh() self-heals either way).
    expect(gateway.emitUnreadCount).not.toHaveBeenCalled();
  });

  it('releases the dedup marker and rethrows when the write fails, so a later re-observation is not permanently dropped', async () => {
    dedup.tryAcquire.mockResolvedValue(true);
    const writeError = new Error('connection pool exhausted');
    feed.recordAndCountUnread.mockRejectedValue(writeError);

    await expect(channel.send(notifiable, notification)).rejects.toThrow(
      'connection pool exhausted',
    );
    expect(dedup.release).toHaveBeenCalledWith(
      'database:invitation-claimed:th_1:ak_recipient',
    );
    expect(gateway.emitToAddress).not.toHaveBeenCalled();
  });

  it('still rethrows the original write error even if the dedup release itself fails', async () => {
    dedup.tryAcquire.mockResolvedValue(true);
    feed.recordAndCountUnread.mockRejectedValue(new Error('write failed'));
    dedup.release.mockRejectedValue(new Error('redis down'));

    await expect(channel.send(notifiable, notification)).rejects.toThrow(
      'write failed',
    );
  });

  it('throws when routed a notification that cannot render for the feed', async () => {
    dedup.tryAcquire.mockResolvedValue(true);
    const noRenderer: any = {
      type: 'mystery',
      dedupKey: () => 'k',
      via: () => ['database'],
      toExpo: () => ({ title: 't', body: 'b' }),
      // no toDatabase
    };
    await expect(channel.send(notifiable, noRenderer)).rejects.toThrow(
      /no toDatabase/,
    );
  });

  it('releases the dedup marker and rethrows when the RENDERER (toDatabase) throws, so a later re-observation is not permanently dropped', async () => {
    // Regression: toDatabase() used to run AFTER tryAcquire but OUTSIDE the
    // try/release block below it, so a throwing renderer leaked the marker
    // for the full dedup TTL with no feed row ever written — the exact
    // permanent-drop failure mode the write-failure catch already guards
    // against, just one line earlier than that catch used to reach.
    dedup.tryAcquire.mockResolvedValue(true);
    const throwingRenderer: any = {
      type: 'mystery',
      dedupKey: () => 'k',
      via: () => ['database'],
      toDatabase: () => {
        throw new Error('render boom');
      },
    };

    await expect(channel.send(notifiable, throwingRenderer)).rejects.toThrow(
      'render boom',
    );

    expect(dedup.release).toHaveBeenCalledWith('database:mystery:k');
    expect(feed.recordAndCountUnread).not.toHaveBeenCalled();
  });
});

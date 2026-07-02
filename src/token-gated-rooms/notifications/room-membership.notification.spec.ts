import { RoomMembershipNotification } from './room-membership.notification';

describe('RoomMembershipNotification', () => {
  const SALE = 'ct_sale';
  const ADDR = 'ak_member' as any;

  it('has the room-membership META and mirrors it onto the instance', () => {
    expect(RoomMembershipNotification.META.type).toBe('room-membership');
    expect(RoomMembershipNotification.META.title).toBe('Room membership');
    expect(RoomMembershipNotification.META.description.length).toBeGreaterThan(
      0,
    );
    const n = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'added',
    });
    expect(n.type).toBe(RoomMembershipNotification.META.type);
    expect(n.title).toBe(RoomMembershipNotification.META.title);
    expect(n.description).toBe(RoomMembershipNotification.META.description);
  });

  it('routes through the expo channel only', () => {
    const n = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'added',
    });
    expect(n.via()).toEqual(['expo']);
  });

  it('builds a dedup key distinct per (saleAddress, change, address)', () => {
    const added = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'added',
    });
    const removed = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'removed',
    });
    expect(added.dedupKey({ address: ADDR })).toBe(
      `room-membership:${SALE}:added:${ADDR}`,
    );
    // add vs remove are distinct (never collapse)
    expect(removed.dedupKey({ address: ADDR })).not.toBe(
      added.dedupKey({ address: ADDR }),
    );
    // repeated adds for same (room, recipient) collapse
    const added2 = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'added',
    });
    expect(added2.dedupKey({ address: ADDR })).toBe(
      added.dedupKey({ address: ADDR }),
    );
    // different recipient → distinct key
    expect(added.dedupKey({ address: 'ak_other' as any })).not.toBe(
      added.dedupKey({ address: ADDR }),
    );
  });

  it('keys the dedup on the ledger event id so distinct transitions never collapse', () => {
    // Two DISTINCT access transitions (e.g. a grant then a real regain within the
    // dedup TTL) both carry change='added' but different ledger event ids → the
    // Redis dedup must NOT collapse them (that would drop the "you're back" push).
    const grant = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'added',
      accessEventId: '1',
    });
    const regain = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'added',
      accessEventId: '2',
    });
    expect(grant.dedupKey({ address: ADDR })).toBe(
      `room-membership:${SALE}:evt:1:${ADDR}`,
    );
    expect(regain.dedupKey({ address: ADDR })).not.toBe(
      grant.dedupKey({ address: ADDR }),
    );
    // Same event redelivered (Bull retry) → SAME key (true-duplicate idempotency).
    const grantRetry = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'added',
      accessEventId: '1',
    });
    expect(grantRetry.dedupKey({ address: ADDR })).toBe(
      grant.dedupKey({ address: ADDR }),
    );
  });

  it('renders a "you\'re back" copy for a non-first-grant re-add', () => {
    const regained = new RoomMembershipNotification({
      saleAddress: SALE,
      symbol: 'FOO',
      change: 'added',
      isFirstGrant: false,
    }).toExpo();
    expect(regained.body).toContain("back in");
    expect(regained.body).toContain('FOO');
  });

  it('renders distinct added vs removed copy and a data payload', () => {
    const added = new RoomMembershipNotification({
      saleAddress: SALE,
      symbol: 'FOO',
      change: 'added',
    }).toExpo();
    expect(added.title).toBe('Room access');
    expect(added.body).toContain('now have access');
    expect(added.body).toContain('FOO');
    expect(added.data).toEqual({
      type: 'room-membership',
      saleAddress: SALE,
      change: 'added',
    });

    const removed = new RoomMembershipNotification({
      saleAddress: SALE,
      symbol: 'FOO',
      change: 'removed',
    }).toExpo();
    expect(removed.body).toContain('no longer have access');
    expect(removed.body).not.toBe(added.body);
    expect(removed.data).toEqual({
      type: 'room-membership',
      saleAddress: SALE,
      change: 'removed',
    });
  });

  it('falls back to generic copy without a symbol', () => {
    const n = new RoomMembershipNotification({
      saleAddress: SALE,
      change: 'added',
    }).toExpo();
    expect(n.body).toContain('a room');
  });
});

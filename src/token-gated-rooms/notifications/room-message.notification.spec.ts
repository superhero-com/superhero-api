import { RoomMessageNotification } from './room-message.notification';

describe('RoomMessageNotification', () => {
  const SALE = 'ct_sale';
  const ADDR = 'ak_member' as any;

  it('has the room-messages META and mirrors it onto the instance', () => {
    expect(RoomMessageNotification.META.type).toBe('room-messages');
    expect(RoomMessageNotification.META.title).toBe('Room messages');
    expect(RoomMessageNotification.META.description.length).toBeGreaterThan(0);
    const n = new RoomMessageNotification({ saleAddress: SALE });
    expect(n.type).toBe(RoomMessageNotification.META.type);
    expect(n.title).toBe(RoomMessageNotification.META.title);
    expect(n.description).toBe(RoomMessageNotification.META.description);
  });

  it('routes through the expo channel only', () => {
    const n = new RoomMessageNotification({ saleAddress: SALE });
    expect(n.via()).toEqual(['expo']);
  });

  it('builds a room-scoped dedup key (with optional messageKey suffix)', () => {
    const base = new RoomMessageNotification({ saleAddress: SALE });
    expect(base.dedupKey({ address: ADDR })).toBe(
      `room-messages:${SALE}:${ADDR}`,
    );
    const keyed = new RoomMessageNotification({
      saleAddress: SALE,
      messageKey: 'w1',
    });
    expect(keyed.dedupKey({ address: ADDR })).toBe(
      `room-messages:${SALE}:${ADDR}:w1`,
    );
    expect(keyed.dedupKey({ address: ADDR })).not.toBe(
      base.dedupKey({ address: ADDR }),
    );
  });

  it('renders the expo body + room-scoped data payload', () => {
    const msg = new RoomMessageNotification({
      saleAddress: SALE,
      symbol: 'BAR',
    }).toExpo();
    expect(msg.title).toBe('New messages');
    expect(msg.body).toContain('BAR');
    expect(msg.data).toEqual({ type: 'room-messages', saleAddress: SALE });
  });
});

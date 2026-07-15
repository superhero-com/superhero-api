import {
  NOTIFICATION_CATALOG,
  NOTIFICATION_CATALOG_BY_TYPE,
} from './notification-catalog';

describe('NOTIFICATION_CATALOG — room types (Task 12)', () => {
  it('contains both room-membership and room-messages', () => {
    const types = NOTIFICATION_CATALOG.map((m) => m.type);
    expect(types).toContain('room-membership');
    expect(types).toContain('room-messages');
  });

  it('whitelists both room types in the by-type map (so applyPartial accepts them)', () => {
    expect(NOTIFICATION_CATALOG_BY_TYPE.has('room-membership')).toBe(true);
    expect(NOTIFICATION_CATALOG_BY_TYPE.has('room-messages')).toBe(true);
  });

  it('has unique type ids', () => {
    const types = NOTIFICATION_CATALOG.map((m) => m.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

import {
  BACKFILL_KICKOFF_JOB,
  BACKFILL_ON_BOOT_ENV,
  BACKFILL_STALE_SWEEP_JOB,
  parseBool,
  ROOM_BACKFILL_QUEUE,
  ROOM_BACKFILL_STATE_ID,
  STALE_PENDING_MS,
} from '../room-backfill.constants';

describe('room-backfill constants (Task 09)', () => {
  it('registers under the worker: prefix (never steals main: indexer jobs)', () => {
    expect(ROOM_BACKFILL_QUEUE).toBe('worker:room-backfill');
  });

  it('declares the canonical job names + cursor id + boot flag', () => {
    expect(BACKFILL_KICKOFF_JOB).toBe('backfill-kickoff');
    expect(BACKFILL_STALE_SWEEP_JOB).toBe('backfill-stale-sweep');
    expect(ROOM_BACKFILL_STATE_ID).toBe('global');
    expect(BACKFILL_ON_BOOT_ENV).toBe('TG_BACKFILL_ON_BOOT');
  });

  it('stale-pending threshold is 24h in ms', () => {
    expect(STALE_PENDING_MS).toBe(24 * 60 * 60 * 1000);
  });

  describe('parseBool', () => {
    it('defaults on blank/undefined', () => {
      expect(parseBool(undefined, false)).toBe(false);
      expect(parseBool('', true)).toBe(true);
      expect(parseBool('   ', false)).toBe(false);
    });
    it('parses true/false case-insensitively', () => {
      expect(parseBool('true', false)).toBe(true);
      expect(parseBool('TRUE', false)).toBe(true);
      expect(parseBool('false', true)).toBe(false);
      expect(parseBool('yes', false)).toBe(false); // only "true" is truthy
    });
  });
});

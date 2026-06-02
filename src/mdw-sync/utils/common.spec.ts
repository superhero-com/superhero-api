import { microTimeToDate } from './common';

describe('microTimeToDate', () => {
  it('returns null for empty, nullish or non-positive input', () => {
    expect(microTimeToDate(undefined)).toBeNull();
    expect(microTimeToDate(null)).toBeNull();
    expect(microTimeToDate('')).toBeNull();
    expect(microTimeToDate('0')).toBeNull();
    expect(microTimeToDate('-5')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(microTimeToDate('not-a-number')).toBeNull();
  });

  it('scales current microsecond timestamps down to milliseconds', () => {
    // 1_700_000_000_000_000 us == 1_700_000_000_000 ms (Nov 2023)
    expect(microTimeToDate('1700000000000000')).toEqual(
      new Date(1_700_000_000_000),
    );
  });

  it('uses 13-digit epoch-millisecond values as-is (not divided back to 1970)', () => {
    // A real millisecond timestamp must round-trip to its own instant, not be
    // re-scaled down to ~1970.
    const ms = 1_700_000_000_000;
    const result = microTimeToDate(String(ms));
    expect(result).toEqual(new Date(ms));
    expect(result!.getUTCFullYear()).toBe(2023);
  });

  it('scales second-precision values up to milliseconds', () => {
    expect(microTimeToDate('1700000000')).toEqual(new Date(1_700_000_000_000));
  });
});

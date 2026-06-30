import {
  clampLimit,
  clampPage,
  clampPaginationOptions,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
} from './pagination';

describe('pagination guards', () => {
  describe('clampLimit', () => {
    it('caps an oversized limit at MAX_PAGE_LIMIT', () => {
      expect(clampLimit(100_000_000)).toBe(MAX_PAGE_LIMIT);
    });

    it('raises a zero/negative limit to 1', () => {
      expect(clampLimit(0)).toBe(1);
      expect(clampLimit(-5)).toBe(1);
    });

    it('passes a valid limit through and floors fractions', () => {
      expect(clampLimit(25)).toBe(25);
      expect(clampLimit(25.9)).toBe(25);
    });

    it('falls back for non-numeric input', () => {
      expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
      expect(clampLimit('abc')).toBe(DEFAULT_PAGE_LIMIT);
      expect(clampLimit(NaN)).toBe(DEFAULT_PAGE_LIMIT);
    });

    it('honours a custom max', () => {
      expect(clampLimit(500, 50)).toBe(50);
    });
  });

  describe('clampPage', () => {
    it('raises a zero/negative page to 1', () => {
      expect(clampPage(0)).toBe(1);
      expect(clampPage(-3)).toBe(1);
    });

    it('passes a valid page through and floors fractions', () => {
      expect(clampPage(4)).toBe(4);
      expect(clampPage(4.7)).toBe(4);
    });

    it('defaults to 1 for non-numeric input', () => {
      expect(clampPage(undefined)).toBe(1);
      expect(clampPage('x')).toBe(1);
    });
  });

  describe('clampPaginationOptions', () => {
    it('clamps both fields without mutating the input', () => {
      const input = { page: 0, limit: 10_000, extra: 'kept' };
      const out = clampPaginationOptions(input);

      expect(out).toEqual({ page: 1, limit: MAX_PAGE_LIMIT, extra: 'kept' });
      // Original object is untouched.
      expect(input.page).toBe(0);
      expect(input.limit).toBe(10_000);
    });
  });
});

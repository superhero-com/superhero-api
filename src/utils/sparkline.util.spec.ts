import { parseSvgDimension } from './sparkline.util';

describe('parseSvgDimension', () => {
  it('parses a valid integer string', () => {
    expect(parseSvgDimension('200', 100)).toBe(200);
  });

  it('floors fractional values', () => {
    expect(parseSvgDimension('150.9', 100)).toBe(150);
  });

  it('returns fallback for NaN', () => {
    expect(parseSvgDimension('abc', 100)).toBe(100);
  });

  it('treats empty string as 0, clamped to 1', () => {
    // Number('') is 0, which is finite, so it gets clamped to min=1
    expect(parseSvgDimension('', 100)).toBe(1);
  });

  it('returns fallback for Infinity', () => {
    expect(parseSvgDimension('Infinity', 100)).toBe(100);
  });

  it('clamps negative values to 1', () => {
    expect(parseSvgDimension('-50', 100)).toBe(1);
  });

  it('clamps zero to 1', () => {
    expect(parseSvgDimension('0', 100)).toBe(1);
  });

  it('clamps values above 2000 to 2000', () => {
    expect(parseSvgDimension('5000', 100)).toBe(2000);
  });

  it('allows the boundary value 2000', () => {
    expect(parseSvgDimension('2000', 100)).toBe(2000);
  });

  it('allows the boundary value 1', () => {
    expect(parseSvgDimension('1', 100)).toBe(1);
  });
});

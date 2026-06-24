import { resolveTrustProxyValue } from './trust-proxy';

describe('resolveTrustProxyValue', () => {
  let logUnrecognized: jest.Mock;

  beforeEach(() => {
    logUnrecognized = jest.fn();
  });

  it('returns undefined when unset', () => {
    expect(resolveTrustProxyValue(undefined, logUnrecognized)).toBeUndefined();
    expect(logUnrecognized).not.toHaveBeenCalled();
  });

  it('returns undefined when empty', () => {
    expect(resolveTrustProxyValue('', logUnrecognized)).toBeUndefined();
    expect(logUnrecognized).not.toHaveBeenCalled();
  });

  it('parses a clean hop count as a number', () => {
    expect(resolveTrustProxyValue('1', logUnrecognized)).toBe(1);
    expect(resolveTrustProxyValue('2', logUnrecognized)).toBe(2);
    expect(logUnrecognized).not.toHaveBeenCalled();
  });

  it('parses "true"/"false" as booleans', () => {
    expect(resolveTrustProxyValue('true', logUnrecognized)).toBe(true);
    expect(resolveTrustProxyValue('false', logUnrecognized)).toBe(false);
    expect(logUnrecognized).not.toHaveBeenCalled();
  });

  it('trims trailing/leading whitespace before every check, so "true " resolves to the boolean, not a raw string', () => {
    // Regression: the previous implementation only trimmed inside the
    // numeric round-trip check, so 'true ' fell through the untrimmed
    // 'true'/'false' comparisons and reached Express as a literal string.
    expect(resolveTrustProxyValue('true ', logUnrecognized)).toBe(true);
    expect(resolveTrustProxyValue(' false', logUnrecognized)).toBe(false);
    expect(resolveTrustProxyValue(' 1 ', logUnrecognized)).toBe(1);
    expect(logUnrecognized).not.toHaveBeenCalled();
  });

  it('passes a preset/CIDR string straight through and warns via the callback', () => {
    expect(resolveTrustProxyValue('loopback', logUnrecognized)).toBe(
      'loopback',
    );
    expect(logUnrecognized).toHaveBeenCalledWith('loopback', 'loopback');
  });

  it('falls through to the raw (trimmed) string and warns for a leading-zero numeric-looking value ("01") — ambiguous by design, so it is surfaced rather than silently accepted', () => {
    // '01' fails the round-trip check (String(1) !== '01'), same as any other
    // non-canonical numeric string; whether that was meant as a hop count or
    // a preset name is undecidable here, so this is reported via the callback
    // instead of one interpretation being silently guessed.
    expect(resolveTrustProxyValue('01', logUnrecognized)).toBe('01');
    expect(logUnrecognized).toHaveBeenCalledWith('01', '01');
  });

  it('reports the raw (untrimmed) value alongside the resolved (trimmed) one to the warning callback', () => {
    resolveTrustProxyValue('  10.0.0.0/8  ', logUnrecognized);
    expect(logUnrecognized).toHaveBeenCalledWith(
      '  10.0.0.0/8  ',
      '10.0.0.0/8',
    );
  });

  it('does not warn for zero, a valid hop count', () => {
    expect(resolveTrustProxyValue('0', logUnrecognized)).toBe(0);
    expect(logUnrecognized).not.toHaveBeenCalled();
  });
});

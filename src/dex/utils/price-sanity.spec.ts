import BigNumber from 'bignumber.js';
import { isSanePrice, MAX_SANE_PRICE } from './price-sanity';

describe('isSanePrice', () => {
  it('accepts ordinary finite prices (incl. 0 and tiny values)', () => {
    expect(isSanePrice('1')).toBe(true);
    expect(isSanePrice('0')).toBe(true);
    expect(isSanePrice('124.45')).toBe(true);
    expect(isSanePrice(new BigNumber('0.0000000001'))).toBe(true);
  });

  it('rejects dust-state artifacts beyond the chartable range', () => {
    expect(isSanePrice('500000000000000000')).toBe(false); // 5e17
    expect(isSanePrice(new BigNumber(MAX_SANE_PRICE).plus(1))).toBe(false);
  });

  it('rejects non-finite and nullish values', () => {
    expect(isSanePrice('NaN')).toBe(false);
    expect(isSanePrice(new BigNumber(Infinity))).toBe(false);
    expect(isSanePrice(null)).toBe(false);
    expect(isSanePrice(undefined)).toBe(false);
  });
});

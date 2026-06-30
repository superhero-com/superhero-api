import { DEX_CONTRACTS } from '../config/dex-contracts.config';
import { humanAmount, isWae, normalizeRatio, priceScale } from './dex-math';

describe('dex-math', () => {
  describe('isWae', () => {
    it('matches only the WAE contract', () => {
      expect(isWae(DEX_CONTRACTS.wae)).toBe(true);
      expect(isWae('ct_other')).toBe(false);
      expect(isWae(null)).toBe(false);
      expect(isWae(undefined)).toBe(false);
    });
  });

  describe('humanAmount', () => {
    it('divides a raw amount by 10^decimals', () => {
      expect(humanAmount('1000000000000000000', 18).toString()).toBe('1');
      expect(humanAmount('2000000', 6).toString()).toBe('2');
      expect(humanAmount('0', 18).toString()).toBe('0');
    });

    it('defaults to 18 decimals and treats nullish raw as 0', () => {
      expect(humanAmount('1000000000000000000', undefined).toString()).toBe(
        '1',
      );
      expect(humanAmount(null, 18).toString()).toBe('0');
    });
  });

  describe('priceScale / normalizeRatio', () => {
    it('scales by 10^(quoteDecimals - baseDecimals)', () => {
      expect(priceScale(6, 18).toString()).toBe('1e-12');
      expect(priceScale(18, 18).toString()).toBe('1');
      expect(priceScale(18, 6).toString()).toBe('1000000000000');
    });

    it('normalizes a raw reserve ratio to a human price', () => {
      // 6-dp token vs 18-dp WAE: raw ratio 5e11 → 0.5 human.
      expect(normalizeRatio('500000000000', 6, 18).toString()).toBe('0.5');
      expect(normalizeRatio('2', 18, 18).toString()).toBe('2');
    });
  });
});

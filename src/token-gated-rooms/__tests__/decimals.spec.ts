import { BigNumber } from 'bignumber.js';
import { toShiftedBigNumber, humanToRaw, hasAtLeast } from '../utils/decimals';

/**
 * Unit coverage for the decimals util (Task 03). The indexed `token_balance` is
 * already raw on-chain; this util only converts human-entered thresholds to raw
 * and compares raw-vs-raw. `Token.decimals` is a STRING — the coercion must work.
 */
describe('decimals util', () => {
  describe('toShiftedBigNumber', () => {
    it('shifts by 0 decimals (no-op)', () => {
      expect(toShiftedBigNumber('7', 0).toFixed()).toBe('7');
    });

    it('shifts by 6 decimals', () => {
      expect(toShiftedBigNumber('1', 6).toFixed()).toBe('1000000');
    });

    it('shifts by 18 decimals', () => {
      expect(toShiftedBigNumber('1', 18).toFixed()).toBe('1000000000000000000');
    });

    it('coerces a STRING precision (Token.decimals is a string)', () => {
      const decimalsAsString: string = '18';
      expect(toShiftedBigNumber('2', decimalsAsString).toFixed()).toBe(
        '2000000000000000000',
      );
    });

    it('coerces a bigint precision', () => {
      expect(toShiftedBigNumber('3', 6n).toFixed()).toBe('3000000');
    });

    it('accepts a BigNumber value', () => {
      expect(toShiftedBigNumber(new BigNumber('5'), 6).toFixed()).toBe(
        '5000000',
      );
    });
  });

  describe('humanToRaw', () => {
    it('decimals 0 → raw equals input integer', () => {
      expect(humanToRaw('42', 0).toFixed()).toBe('42');
    });

    it('decimals 6 → 1.5 tokens = 1_500000 base units', () => {
      expect(humanToRaw('1.5', 6).toFixed()).toBe('1500000');
    });

    it('decimals 18 → 1 token = 10^18 base units', () => {
      expect(humanToRaw('1', 18).toFixed()).toBe('1000000000000000000');
    });

    it('coerces a STRING decimals value', () => {
      const decimals: string = '6';
      expect(humanToRaw('2.5', decimals).toFixed()).toBe('2500000');
    });

    it('floors sub-base-unit precision (base units are integers)', () => {
      // 0.0000001 at 6 decimals would be 0.1 base units → floored to 0
      expect(humanToRaw('0.0000001', 6).toFixed()).toBe('0');
      // 1.9999999 at 6 decimals → 1999999.9 → floored to 1999999
      expect(humanToRaw('1.9999999', 6).toFixed()).toBe('1999999');
    });
  });

  describe('hasAtLeast (raw-vs-raw, no float scaling)', () => {
    it('equal → true (boundary, inclusive)', () => {
      const v = new BigNumber('1000000000000000000');
      expect(hasAtLeast(v, v)).toBe(true);
    });

    it('just-below → false', () => {
      expect(
        hasAtLeast(
          new BigNumber('999999999999999999'),
          new BigNumber('1000000000000000000'),
        ),
      ).toBe(false);
    });

    it('just-above → true', () => {
      expect(
        hasAtLeast(
          new BigNumber('1000000000000000001'),
          new BigNumber('1000000000000000000'),
        ),
      ).toBe(true);
    });

    it('zero balance vs zero threshold → true', () => {
      expect(hasAtLeast(new BigNumber(0), new BigNumber(0))).toBe(true);
    });

    it('compares values beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
      const balance = new BigNumber('9007199254740993000000000000000000');
      const threshold = new BigNumber('9007199254740992000000000000000000');
      expect(hasAtLeast(balance, threshold)).toBe(true);
      expect(hasAtLeast(threshold, balance)).toBe(false);
    });
  });
});

import BigNumber from 'bignumber.js';

/**
 * Maximum representable price magnitude. The charting library rejects any value
 * with |value| >= 9007199254740991/100, and in practice anything that large is
 * the artifact of a dust-state transaction in a near-empty pool — a 1-wei
 * reserve makes reserve0/reserve1 explode into a finite-but-absurd ratio that
 * still passes a `!= 'NaN'` filter. We treat such values as "not a real price"
 * everywhere we consume a historical per-transaction ratio.
 */
export const MAX_SANE_PRICE = 90071992547409.91;

/**
 * True when an already-decimal-normalized (human) price is finite and within the
 * chartable range. Callers must normalize raw reserve ratios to human units
 * first, otherwise a legitimately large raw ratio for a low-decimal token would
 * be misjudged.
 */
export const isSanePrice = (
  value: BigNumber | number | string | null | undefined,
): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  const bn = BigNumber.isBigNumber(value)
    ? value
    : new BigNumber(String(value));
  return bn.isFinite() && bn.abs().isLessThan(MAX_SANE_PRICE);
};

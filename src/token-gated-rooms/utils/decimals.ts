import { BigNumber } from 'bignumber.js';

/**
 * Decimals helpers for AEX9 balances (plan §5.4). The indexed `token_balance`
 * is already stored in **raw integer base units** (the on-chain `Transfer`
 * `value`), so there is no scaling on the indexing path. These helpers exist for
 * the *human → raw* direction (turning an operator-entered threshold like
 * `"5"` tokens at 18 decimals into `5_000000000000000000`) and for raw-vs-raw
 * threshold comparison. Never float-scale a balance for comparison.
 *
 * `Token.decimals` is a **string** (`type:'bigint'`) — every consumer must coerce
 * with `Number(...)` before shifting; that is what `toShiftedBigNumber` does.
 */

/**
 * Mirror of the bot's `toShiftedBigNumber(value, precision)`:
 * `new BigNumber(value).shiftedBy(Number(precision))`. `precision` may be a
 * string (`Token.decimals`), number, or bigint; it is coerced via `Number(...)`.
 */
export function toShiftedBigNumber(
  value: number | string | BigNumber,
  precision: number | bigint | string,
): BigNumber {
  return new BigNumber(value).shiftedBy(Number(precision));
}

/**
 * Convert a human-entered token amount (e.g. `"5"`, `5`, or `BigNumber(5)`) into
 * **raw integer base units** for a token with `decimals` (string|number|bigint).
 * The result is an integer (any fractional remainder finer than the token's
 * precision is floored — base units cannot be fractional).
 *
 * @example humanToRaw('1', 18) // BigNumber('1000000000000000000')
 * @example humanToRaw('1.5', 6) // BigNumber('1500000')
 */
export function humanToRaw(
  amount: number | string | BigNumber,
  decimals: number | bigint | string,
): BigNumber {
  return toShiftedBigNumber(amount, decimals).integerValue(
    BigNumber.ROUND_FLOOR,
  );
}

/**
 * Raw-vs-raw threshold compare (plan §5.4): both args are already raw integer
 * base units; this never scales by decimals. Returns true iff `rawBalance` is at
 * least `rawThreshold` (`rawBalance.gte(rawThreshold)`).
 */
export function hasAtLeast(
  rawBalance: BigNumber,
  rawThreshold: BigNumber,
): boolean {
  return rawBalance.gte(rawThreshold);
}

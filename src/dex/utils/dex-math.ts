import BigNumber from 'bignumber.js';
import { DEX_CONTRACTS } from '../config/dex-contracts.config';

/**
 * Shared DEX decimal math.
 *
 * On-chain DEX values are RAW integers scaled by each token's `decimals`, and
 * stored ratios are RAW reserve ratios. Converting them to human units is the
 * single most duplicated piece of logic across the DEX services — these helpers
 * are the one place that conversion lives, so every endpoint normalizes the same
 * way (and a fix lands once, not in eight places).
 */

/** True when an address is the wrapped-AE (WAE) contract. */
export const isWae = (address: string | undefined | null): boolean =>
  !!address && address === DEX_CONTRACTS.wae;

/**
 * Convert a RAW on-chain amount to human units (`raw / 10^decimals`).
 * Unknown decimals default to 18.
 */
export const humanAmount = (raw: unknown, decimals: unknown): BigNumber =>
  new BigNumber(String(raw ?? '0')).shiftedBy(-Number(decimals ?? 18));

/**
 * Scale that turns a RAW reserve ratio into a human price:
 *   humanPrice = rawRatio * 10^(quoteDecimals - baseDecimals)
 * where `quote` is the token being priced and `base` is the token it is priced
 * in. Unknown decimals default to 18 (→ scale of 1).
 */
export const priceScale = (
  quoteDecimals: unknown,
  baseDecimals: unknown,
): BigNumber =>
  new BigNumber(10).pow(
    Number(quoteDecimals ?? 18) - Number(baseDecimals ?? 18),
  );

/** Normalize a RAW reserve ratio to a human price using the two tokens' decimals. */
export const normalizeRatio = (
  rawRatio: BigNumber.Value,
  quoteDecimals: unknown,
  baseDecimals: unknown,
): BigNumber =>
  new BigNumber(rawRatio).multipliedBy(priceScale(quoteDecimals, baseDecimals));

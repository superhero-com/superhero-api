import 'dotenv/config';
import { Node } from '@aeternity/aepp-sdk';

/** aepp-sdk's hardcoded floor, and what it stamps when it skips network pricing. */
const SDK_MIN_GAS_PRICE = 1_000_000_000n;
/** aepp-sdk refuses a gas price above MIN_GAS_PRICE * 1e5. */
const SDK_MAX_GAS_PRICE = SDK_MIN_GAS_PRICE * 100_000n;
/** The reported utilization at which aepp-sdk starts pricing off the network. */
const SDK_NETWORK_PRICING_UTILIZATION = 70;

export const AE_MIN_GAS_PRICE = resolveMinGasPrice(
  process.env.AE_MIN_GAS_PRICE,
);

export function resolveMinGasPrice(raw: string | undefined): bigint {
  const trimmed = raw?.trim();
  if (!trimmed) return SDK_MIN_GAS_PRICE;

  let parsed: bigint;
  try {
    parsed = BigInt(trimmed);
  } catch {
    console.warn(
      `AE_MIN_GAS_PRICE="${trimmed}" is not an integer, falling back to ${SDK_MIN_GAS_PRICE}`,
    );
    return SDK_MIN_GAS_PRICE;
  }

  if (parsed < SDK_MIN_GAS_PRICE) return SDK_MIN_GAS_PRICE;
  if (parsed > SDK_MAX_GAS_PRICE) {
    console.warn(
      `AE_MIN_GAS_PRICE=${parsed} exceeds the SDK maximum, limiting to ${SDK_MAX_GAS_PRICE}`,
    );
    return SDK_MAX_GAS_PRICE;
  }
  return parsed;
}

// aepp-sdk prices off the network only above 70% reported utilization and stamps a
// hardcoded 1e9 below it — under the relay floor as soon as the network raises it.
// Reported utilization is the only lever it exposes, so pin it and lift the price.
export function pinNetworkGasPricing<T extends Node>(
  node: T,
  floor: bigint = AE_MIN_GAS_PRICE,
): T {
  const getRecentGasPrices = node.getRecentGasPrices.bind(node);

  node.getRecentGasPrices = async (...args) => {
    const prices = await getRecentGasPrices(...args);
    return prices.map((price) => {
      const reported = BigInt(price.minGasPrice ?? 0);
      return {
        ...price,
        minGasPrice: reported > floor ? reported : floor,
        utilization: Math.max(
          price.utilization,
          SDK_NETWORK_PRICING_UTILIZATION,
        ),
      };
    });
  };

  return node;
}

/**
 * Split `items` into fixed-size chunks, last chunk possibly smaller. `size` is
 * clamped to ≥ 1 so a misconfigured 0/NaN input cannot deadlock the caller in
 * a `for (i += 0)` infinite loop. Used by the Expo client and the announcement
 * dispatch fan-out — both producer-side, both want the same semantics.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    out.push(items.slice(i, i + safeSize));
  }
  return out;
}

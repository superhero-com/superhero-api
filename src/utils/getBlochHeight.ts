import { ACTIVE_NETWORK } from '@/configs';
import { fetchJson } from './common';
import { DataSource } from 'typeorm';

// Cache for top block and median interval with TTL
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

let topBlockCache: CacheEntry<{ height: number; time: number }> | null = null;
let medianIntervalCache: CacheEntry<number> | null = null;

/**
 * Get the top (latest) key block from MDW (cached)
 * @returns Object with height and time (in milliseconds)
 */
async function getTop(): Promise<{ height: number; time: number }> {
  const now = Date.now();

  // Return cached data if still valid
  if (topBlockCache && topBlockCache.expiresAt > now) {
    return topBlockCache.data;
  }

  const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/key-blocks?limit=1`;
  const response = await fetchJson<{
    data: Array<{ height: number; time: number }>;
  }>(url);

  if (!response || !response.data || response.data.length === 0) {
    throw new Error('Failed to fetch top key block from MDW');
  }

  const kb = response.data[0];
  const result = { height: kb.height, time: kb.time as number }; // time in ms

  // Cache the result
  topBlockCache = {
    data: result,
    expiresAt: now + CACHE_TTL_MS,
  };

  return result;
}

/**
 * Get a key block at a specific height
 * @param height - The block height to query
 * @returns Object with height and time (in milliseconds)
 * @throws Error if block not found
 */
async function getKeyBlock(
  height: number,
): Promise<{ height: number; time: number }> {
  try {
    const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/key-blocks/${height}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Height ${height} not found: ${response.status} ${response.statusText}`,
      );
    }

    const kb = (await response.json()) as { height: number; time: number };
    return { height: kb.height, time: kb.time as number };
  } catch (error) {
    console.error(`Error fetching key block at height ${height}:`, error);
    throw error;
  }
}

/**
 * List recent key blocks (newest first)
 * @param n - Number of recent blocks to fetch
 * @returns Array of blocks with height and time
 */
async function listRecentKeyBlocks(
  n: number,
): Promise<Array<{ height: number; time: number }>> {
  const url = `${ACTIVE_NETWORK.middlewareUrl}/v3/key-blocks?limit=${n}`;
  const response = await fetchJson<{
    data: Array<{ height: number; time: number }>;
  }>(url);

  if (!response || !response.data) {
    throw new Error('Failed to fetch recent key blocks from MDW');
  }

  return response.data.map((kb) => ({
    height: kb.height,
    time: kb.time as number,
  }));
}

/**
 * Calculate the median of an array of numbers
 * @param xs - Array of numbers
 * @returns Median value
 */
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const a = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Get the median interval between recent key blocks (cached)
 * Robust recent interval (ms) = median of last N inter-block gaps.
 * Default N=33 (→ 32 gaps). You can tune this.
 * @param N - Number of recent blocks to analyze (default 33)
 * @returns Median interval in milliseconds
 */
async function getRecentMedianIntervalMs(N = 33): Promise<number> {
  const now = Date.now();

  // Return cached data if still valid
  if (medianIntervalCache && medianIntervalCache.expiresAt > now) {
    return medianIntervalCache.data;
  }

  const blocks = await listRecentKeyBlocks(N);
  const gaps: number[] = [];

  for (let i = 0; i < blocks.length - 1; i++) {
    gaps.push(Math.abs(blocks[i].time - blocks[i + 1].time));
  }

  // Fallback if something odd
  const med = median(gaps);
  const result = Number.isFinite(med) ? med : 180_000; // ~3 min default

  // Cache the result
  medianIntervalCache = {
    data: result,
    expiresAt: now + CACHE_TTL_MS,
  };

  return result;
}

/**
 * Get approximate block height from database by querying transactions around the target time
 * @param targetMs - Target timestamp in milliseconds
 * @param dataSource - Optional TypeORM DataSource for database queries
 * @param useHourPrecision - If true, uses ±1 hour window; if false, uses full day range
 * @returns Approximate block height or null if not found
 */
async function getApproximateBlockHeightFromDB(
  targetMs: number,
  dataSource?: DataSource,
  useHourPrecision: boolean = false,
): Promise<number | null> {
  if (!dataSource) {
    return null;
  }

  try {
    let startWindow: Date;
    let endWindow: Date;

    if (useHourPrecision) {
      // Use a window around the target time (±1 hour) to find transactions near the specific hour
      const windowMs = 60 * 60 * 1000; // 1 hour in milliseconds
      startWindow = new Date(targetMs - windowMs);
      endWindow = new Date(targetMs + windowMs);
    } else {
      // Use full day range (date-only precision)
      const targetDate = new Date(targetMs);
      startWindow = new Date(targetDate);
      startWindow.setHours(0, 0, 0, 0);
      endWindow = new Date(targetDate);
      endWindow.setHours(23, 59, 59, 999);
    }

    const result = await dataSource
      .createQueryBuilder()
      .select('tx.block_height', 'block_height')
      .from('transactions', 'tx')
      .where('tx.created_at >= :startWindow', { startWindow })
      .andWhere('tx.created_at <= :endWindow', { endWindow })
      .andWhere('tx.block_height IS NOT NULL')
      .andWhere('tx.block_height > 0')
      .orderBy('tx.created_at', 'DESC')
      .limit(1)
      .getRawOne();

    if (result && result.block_height) {
      return Number(result.block_height);
    }

    return null;
  } catch (error) {
    console.warn(
      `[getApproximateBlockHeightFromDB] Error querying database:`,
      error,
    );
    return null;
  }
}

/**
 * Returns the greatest key-block height whose time <= target timestamp.
 * Uses hour-level precision if target is within 48 hours of current time, otherwise uses day-level precision.
 * @param targetMs - Target timestamp in milliseconds
 * @param previousHeight - Optional previous block height for sequential optimization
 * @param dataSource - Optional TypeORM DataSource for database queries
 * @returns Block height for the target timestamp
 */
export async function timestampToAeHeight(
  targetMs: number,
  previousHeight?: number,
  dataSource?: DataSource,
): Promise<number> {
  let requestCount = 0;
  let binarySearchIterations = 0;
  let sanityCheckIterations = 0;

  const targetDate = new Date(targetMs);
  
  // Request 1: Get top block (cached)
  requestCount++;
  const top = await getTop();

  // Check if target is within 48 hours of current time to determine precision
  const hours48Ms = 48 * 60 * 60 * 1000; // 48 hours in milliseconds
  const timeDiff = top.time - targetMs;
  const useHourPrecision = timeDiff >= 0 && timeDiff <= hours48Ms;

  // Use hour-level precision if within 48 hours, otherwise use day-level precision
  const targetTimestampMs = useHourPrecision 
    ? targetMs 
    : (() => {
        // Convert to end of day for day-level precision
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        return endOfDay.getTime();
      })();

  // Trivial clamp: if target timestamp is at or after tip, return tip height
  if (targetTimestampMs >= top.time) {
    // console.log(
    //   `[timestampToAeHeight] Target timestamp is at or after tip, returning top height ${top.height}. Total requests: ${requestCount}`,
    // );
    return top.height;
  }

  // Try to get approximate block height from database
  let guess: number | null = null;

  if (dataSource) {
    guess = await getApproximateBlockHeightFromDB(targetMs, dataSource, useHourPrecision);
  }

  if (guess) {
    return guess;
  }

  // If we have a previous height and no DB guess, use sequential estimation
  // For sequential timestamps, we can estimate based on typical interval
  if (!guess && previousHeight) {
    // Request 2: Get recent blocks for median interval calculation (cached)
    requestCount++;
    const intervalMs = await getRecentMedianIntervalMs(33); // ~32 recent intervals

    // Calculate time difference from previous timestamp
    // If previousHeight was used, we need to estimate based on time difference
    // For now, use a conservative estimate if we don't have the previous timestamp
    const estimatedBlocks = Math.floor(
      (targetTimestampMs - (top.time - (top.height - previousHeight) * intervalMs)) / intervalMs,
    );
    guess = previousHeight + estimatedBlocks;
  }

  // If still no guess, use linear estimate from tip
  if (!guess) {
    // Request 2: Get recent blocks for median interval calculation (cached)
    requestCount++;
    const intervalMs = await getRecentMedianIntervalMs(33); // ~32 recent intervals

    // Linear estimate from tip:
    // delta heights ≈ (nowMs - targetTimestampMs) / intervalMs
    const deltaH = Math.max(
      0,
      Math.floor((top.time - targetTimestampMs) / intervalMs),
    );
    guess = Math.max(1, top.height - deltaH);
  }

  // Adjust search window based on precision level
  let halfWindow: number;
  if (useHourPrecision) {
    // With hour-level precision, we can use a smaller search window
    // Blocks are ~3 minutes apart, so 1 hour = ~20 blocks
    // Use a window that covers ±2 hours around the guess for safety
    halfWindow = 40; // Covers ~2 hours range (±20 blocks)
  } else {
    // With day-level precision, we need a larger search window
    // Blocks are ~3 minutes apart, so 24 hours = ~480 blocks
    // Use a window that covers ±12 hours around the guess
    halfWindow = 240; // Covers ~12 hours range (half a day)
  }
  let low = Math.max(1, guess - halfWindow);
  let high = Math.min(top.height, guess + halfWindow);

  // Ensure the window is not empty (edge cases)
  if (low > high) {
    [low, high] = [high, low];
  }

  // Binary search within [low, high] - looking for block at target timestamp
  while (low < high) {
    binarySearchIterations++;
    const mid = Math.floor((low + high + 1) / 2);

    requestCount++;
    const { time } = await getKeyBlock(mid);

    if (time <= targetTimestampMs) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  // If our guess window somehow started completely after target,
  // low could end up below the true block with time > target.
  // Sanity check and correct by stepping back if needed.
  // (Usually unnecessary; left as defensive guard.)
  try {
    requestCount++;
    let { time: lowTime } = await getKeyBlock(low);

    while (low > 1 && lowTime > targetTimestampMs) {
      sanityCheckIterations++;
      low--;

      requestCount++;
      lowTime = (await getKeyBlock(low)).time;
    }
  } catch (error) {
    console.warn(
      `[timestampToAeHeight] Error in sanity check for timestamp ${targetMs}, using low=${low}:`,
      error,
    );
    // Continue with current low value
  }

  const totalIterations = binarySearchIterations + sanityCheckIterations;
//   console.log(
//     `[timestampToAeHeight] Final result: block height ${low} for timestamp ${targetDate.toISOString()} (${new Date(targetTimestampMs).toISOString()})`,
//   );
//   console.log(
//     `[timestampToAeHeight] Summary: ${totalIterations} total iterations (${binarySearchIterations} binary search + ${sanityCheckIterations} sanity check), ${requestCount} total API requests`,
//   );

  return low;
}

import {
  MAX_RETRIES_WHEN_REQUEST_FAILED,
  WAIT_TIME_WHEN_REQUEST_FAILED,
} from '@/configs/constants';

/**
 * Fetches JSON data from the specified URL.
 *
 * @param url - The URL to fetch the JSON data from.
 * @param options - Optional request options.
 * @returns A promise that resolves to the JSON data or null if the response status is 204.
 */
export async function fetchJson<T = any>(
  url: string,
  options?: RequestInit,
  shouldNotRetry = false,
  totalRetries = 1,
): Promise<T | null> {
  try {
    const response = await fetch(url, options);
    if (response.status === 204) {
      return null;
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (totalRetries < MAX_RETRIES_WHEN_REQUEST_FAILED && !shouldNotRetry) {
      totalRetries++;
      await new Promise((resolve) =>
        setTimeout(resolve, WAIT_TIME_WHEN_REQUEST_FAILED),
      );
      return fetchJson(url, options, shouldNotRetry, totalRetries);
    }
    throw error;
  }
}

/**
 * Recursively convert BigInt values to strings for JSON serialization.
 * Handles BigInt primitives, Map objects with BigInt keys, arrays, and plain objects.
 *
 * @param obj - The object to serialize
 * @returns The serialized object with BigInt values converted to strings
 */
export function serializeBigInts(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  // Handle Map objects
  if (obj instanceof Map) {
    const serialized: any = {};
    for (const [key, value] of obj.entries()) {
      // Convert BigInt keys to strings
      const serializedKey = typeof key === 'bigint' ? key.toString() : key;
      serialized[serializedKey] = serializeBigInts(value);
    }
    return serialized;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => serializeBigInts(item));
  }

  if (typeof obj === 'object') {
    const serialized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      serialized[key] = serializeBigInts(value);
    }
    return serialized;
  }

  return obj;
}

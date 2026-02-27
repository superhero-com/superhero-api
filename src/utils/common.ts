import {
  MAX_RETRIES_WHEN_REQUEST_FAILED,
  WAIT_TIME_WHEN_REQUEST_FAILED,
} from '@/configs/constants';

/**
 * Default HTTP request timeout in milliseconds.
 * Prevents fetch calls from hanging indefinitely when a remote server stops responding.
 */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetches JSON data from the specified URL.
 *
 * @param url - The URL to fetch the JSON data from.
 * @param options - Optional request options.
 * @param shouldNotRetry - When true, do not retry on failure.
 * @param totalRetries - Internal retry counter (do not pass manually).
 * @param timeoutMs - Per-request timeout in ms (default 30 s). Pass 0 to disable.
 * @returns A promise that resolves to the JSON data or null if the response status is 204.
 */
export async function fetchJson<T = any>(
  url: string,
  options?: RequestInit,
  shouldNotRetry = false,
  totalRetries = 1,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<T | null> {
  // Set up a per-request AbortController timeout unless the caller already
  // supplied a signal (in which case we respect it and skip our own timer).
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  if (timeoutMs > 0 && !options?.signal) {
    controller = new AbortController();
    timer = setTimeout(
      () => controller!.abort(new Error(`fetchJson timed out after ${timeoutMs}ms: ${url}`)),
      timeoutMs,
    );
  }

  try {
    const fetchOptions: RequestInit = controller
      ? { ...options, signal: controller.signal }
      : { ...options };

    const response = await fetch(url, fetchOptions);
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
      return fetchJson(url, options, shouldNotRetry, totalRetries, timeoutMs);
    }
    throw error;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
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

/**
 * Recursively sanitizes strings in an object/array by removing null bytes (\u0000)
 * and other problematic Unicode characters that PostgreSQL cannot handle.
 * This is necessary because PostgreSQL JSONB columns cannot contain null bytes.
 *
 * @param obj - The object, array, or primitive to sanitize
 * @returns The sanitized object with null bytes removed from all strings
 */
export function sanitizeJsonForPostgres(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Remove null bytes and other control characters that PostgreSQL cannot handle
    // Keep only printable characters and common whitespace (space, tab, newline, carriage return)
    return obj.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeJsonForPostgres(item));
  }

  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeJsonForPostgres(value);
    }
    return sanitized;
  }

  return obj;
}

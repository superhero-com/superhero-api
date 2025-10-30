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
  } catch (error: any) {
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

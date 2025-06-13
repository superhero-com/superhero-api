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
): Promise<T | null> {
  let totalRetries = 0;
  try {
    const response = await fetch(url, options);
    if (response.status === 204) {
      return null;
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (totalRetries < 3 && !shouldNotRetry) {
      totalRetries++;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return fetchJson(url, options, shouldNotRetry);
    }
    throw error;
  }
}

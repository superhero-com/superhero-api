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
): Promise<T | null> {
  const response = await fetch(url, options);
  if (response.status === 204) {
    return null;
  }
  return response.json() as Promise<T>;
}

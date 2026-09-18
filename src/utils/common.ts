import {
  MAX_RETRIES_WHEN_REQUEST_FAILED,
  WAIT_TIME_WHEN_REQUEST_FAILED,
} from '@/configs/constants';
import { incrementFetchTimeout } from './stabilization-metrics';

const DEFAULT_FETCH_JSON_TIMEOUT_MS = 30_000;
const rawTimeout = Number(
  process.env.FETCH_JSON_TIMEOUT_MS ?? DEFAULT_FETCH_JSON_TIMEOUT_MS,
);
const FETCH_JSON_TIMEOUT_MS =
  Number.isFinite(rawTimeout) && rawTimeout > 0
    ? rawTimeout
    : DEFAULT_FETCH_JSON_TIMEOUT_MS;

export class FetchJsonHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FetchJsonHttpError';
  }
}

export class InvalidMiddlewareNextUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMiddlewareNextUrlError';
  }
}

type MiddlewareNextUrlLogger = {
  warn(message: string, ...optionalParams: unknown[]): void;
};

function formatResponseDetails(
  url: string,
  response: Response,
  bodyText?: string,
): string {
  const bodyPreview = bodyText?.trim()
    ? ` Body preview: ${bodyText.trim().slice(0, 200)}`
    : '';
  return `Request to ${url} failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.${bodyPreview}`;
}

function shouldRetryFetchJsonError(error: unknown): boolean {
  if (error instanceof FetchJsonHttpError) {
    if (error.status === 408 || error.status === 429) {
      return true;
    }
    return error.status >= 500;
  }

  return true;
}

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_JSON_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();

  if (options?.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (response.status === 204) {
      return null;
    }

    const responseText = await response.text();

    if (!response.ok) {
      throw new FetchJsonHttpError(
        formatResponseDetails(url, response, responseText),
        response.status,
      );
    }

    if (!responseText.trim()) {
      throw new SyntaxError(
        `Received an empty JSON response from ${url} with status ${response.status}.`,
      );
    }

    try {
      return JSON.parse(responseText) as T;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SyntaxError(
        `Failed to parse JSON from ${url} with status ${response.status}: ${reason}`,
      );
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      // Respect caller cancellation: do not retry when the parent signal aborted.
      if (options?.signal?.aborted) {
        throw error;
      }
      incrementFetchTimeout();
    }
    if (
      totalRetries < MAX_RETRIES_WHEN_REQUEST_FAILED &&
      !shouldNotRetry &&
      shouldRetryFetchJsonError(error)
    ) {
      totalRetries++;
      await new Promise((resolve) =>
        setTimeout(resolve, WAIT_TIME_WHEN_REQUEST_FAILED),
      );
      return fetchJson(url, options, shouldNotRetry, totalRetries);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener('abort', onParentAbort);
  }
}

export function resolveMiddlewareNextUrl(
  next: string | null | undefined,
  middlewareUrl: string,
): string | null {
  if (!next) {
    return null;
  }

  let baseUrl: URL;
  let resolvedUrl: URL;

  try {
    baseUrl = new URL(middlewareUrl);
    const basePath = baseUrl.pathname.replace(/\/$/, '');
    resolvedUrl = next.startsWith('/')
      ? new URL(`${baseUrl.origin}${basePath}${next}`)
      : new URL(next, `${middlewareUrl.replace(/\/$/, '')}/`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidMiddlewareNextUrlError(
      `Invalid middleware next URL "${next}": ${reason}`,
    );
  }

  if (resolvedUrl.origin !== baseUrl.origin) {
    throw new InvalidMiddlewareNextUrlError(
      `Rejected middleware next URL "${next}" because it resolves outside ${baseUrl.origin}`,
    );
  }

  return resolvedUrl.toString();
}

export function resolveMiddlewareNextUrlSafely(
  next: string | null | undefined,
  middlewareUrl: string,
  logger: MiddlewareNextUrlLogger,
  context: string,
): string | null {
  try {
    return resolveMiddlewareNextUrl(next, middlewareUrl);
  } catch (error) {
    logger.warn(
      `${context}: stopping pagination after invalid next URL`,
      error,
    );
    return null;
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
 * MDW serialises event `topics` as decimal strings, but aepp-sdk's
 * `$decodeEvents` matches them against the BigInt event-name hash with strict
 * equality — a string topic never matches, so with `omitUnknown: true` every
 * event is silently dropped. Normalise each topic to BigInt before decoding.
 * A single unconvertible topic (an unrelated log line in the same tx) is left
 * untouched so it is dropped alone rather than aborting the whole log.
 */
export function normalizeEventTopics(log: any[] | undefined | null): any[] {
  const toBigIntTopic = (topic: any): any => {
    if (typeof topic === 'bigint') return topic;
    try {
      return BigInt(topic);
    } catch {
      return topic;
    }
  };
  return (log ?? []).map((entry: any) => ({
    ...entry,
    topics: Array.isArray(entry?.topics)
      ? entry.topics.map(toBigIntTopic)
      : entry?.topics,
  }));
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
    return obj
      .replace(/\u0000/g, '')
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '');
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

/**
 * Pagination guards shared across paginated endpoints.
 *
 * `ParseIntPipe` only validates integer-ness — it does not bound the value, so
 * a client could request `?limit=100000000` and force a full-table scan and
 * serialization of a large, hot table. Clamp at the service layer so every
 * caller (HTTP and internal) is protected.
 */
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 100;

/**
 * Clamp a requested page size to `[1, max]`, falling back to `fallback` for
 * missing/non-numeric input.
 */
export function clampLimit(
  limit: unknown,
  max: number = MAX_PAGE_LIMIT,
  fallback: number = DEFAULT_PAGE_LIMIT,
): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) {
    return Math.min(fallback, max);
  }
  return Math.min(Math.max(Math.floor(n), 1), max);
}

/** Clamp a requested page number to `>= 1`. */
export function clampPage(page: unknown): number {
  const n = Number(page);
  if (!Number.isFinite(n)) {
    return 1;
  }
  return Math.max(Math.floor(n), 1);
}

/**
 * Clamp the `page`/`limit` of an nestjs-typeorm-paginate options object.
 * Returns a new object; does not mutate the input.
 */
export function clampPaginationOptions<
  T extends { page?: unknown; limit?: unknown },
>(
  options: T,
  max: number = MAX_PAGE_LIMIT,
): T & { page: number; limit: number } {
  return {
    ...options,
    page: clampPage(options.page),
    limit: clampLimit(options.limit, max),
  };
}

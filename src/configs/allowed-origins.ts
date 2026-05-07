/**
 * Parse `ALLOWED_ORIGINS` into a value suitable for both the Express CORS
 * middleware and the socket.io `cors.origin` option.
 *
 * This API is intentionally **public**: it is consumed from browsers by
 * third-party dashboards, explorers, and apps we do not know about in
 * advance. Locking CORS down to a hard-coded allowlist would break all of
 * those consumers without providing a real security benefit — the app has
 * no cookie/session auth, and all admin surfaces require an explicit
 * `x-admin-api-key` / `Authorization: Bearer` header which browsers do
 * not attach cross-origin automatically.
 *
 * Behaviour:
 *  - unset / empty → `true` (allow every origin; the default)
 *  - `"*"`         → `true` (explicit wildcard)
 *  - comma list    → `string[]` (pin to an allowlist — useful for internal
 *                    deployments that *do* want strict browser origins)
 *
 * The return type (`string[] | boolean`) is the union accepted by both
 * Express CORS and socket.io.
 */
export function parseAllowedOrigins(): string[] | boolean {
  const raw = process.env.ALLOWED_ORIGINS?.trim();
  if (!raw || raw === '*') return true;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Whether the operator has pinned to an explicit origin allowlist.
 * Used to decide whether it is safe to enable `credentials: true` —
 * browsers reject `Access-Control-Allow-Credentials: true` when the
 * response origin is the wildcard `*`.
 */
export function hasExplicitAllowlist(): boolean {
  const raw = process.env.ALLOWED_ORIGINS?.trim();
  return !!raw && raw !== '*';
}

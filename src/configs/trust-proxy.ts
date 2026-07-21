/**
 * Parse `TRUST_PROXY` into the value Express's `app.set('trust proxy', …)`
 * expects: a hop count, a boolean, or a preset/CIDR string passed straight
 * through. Pulled out of `main.ts` (which has no test coverage of its own) so
 * the parsing edge cases — trailing whitespace, a leading-zero string that
 * looks numeric but isn't — are unit-testable in isolation.
 *
 * The value is trimmed ONCE up front and every branch below tests that same
 * trimmed value; a previous version only trimmed inside the numeric-round-trip
 * check, so `TRUST_PROXY="true "` (trailing whitespace) fell through the
 * untrimmed `=== 'true'` / `=== 'false'` comparisons and reached Express as a
 * literal string, which is not a valid preset/IP notation.
 *
 * A leading-zero numeric string ("01") still fails the round-trip check
 * (`String(1) !== '01'`) and falls through to the raw-string branch — Express
 * then treats it as an IP/CIDR allowlist, which silently trusts nothing and
 * disables proxy trust. That ambiguity can't be resolved without know​ing
 * whether "01" was meant as a hop count or a preset name, so `logUnrecognized`
 * is called in that case — the caller decides how to surface it (main.ts logs
 * a warning) rather than this pure function taking a logging dependency.
 */
export function resolveTrustProxyValue(
  raw: string | undefined,
  logUnrecognized: (rawValue: string, resolvedValue: string) => void,
): boolean | number | string | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const trimmed = raw.trim();
  const asInt = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && String(asInt) === trimmed) {
    return asInt;
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  logUnrecognized(raw, trimmed);
  return trimmed;
}

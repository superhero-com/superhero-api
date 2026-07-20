import proxyaddr from 'proxy-addr';
import { resolveTrustProxyValue } from './trust-proxy';

type TrustFn = (addr: string, index: number) => boolean;

/**
 * Mirrors Express's own `compileTrust` (express/lib/utils.js) so a resolved
 * `TRUST_PROXY` value produces IDENTICAL trust semantics whether it feeds
 * Express's `req.ip` (main.ts) or `resolveClientIp` below, for callers that
 * sit outside Express's request pipeline and so never get an Express-
 * resolved `req.ip` of their own (the socket.io gateway).
 */
function compileTrust(
  value: boolean | number | string | undefined,
): TrustFn | null {
  if (value === undefined || value === false) {
    // Trust nothing: same practical effect as Express's own
    // `proxyaddr.compile([])` for an empty/false trust list — the caller
    // short-circuits to the raw peer address without invoking proxy-addr.
    return null;
  }
  if (value === true) {
    return () => true;
  }
  if (typeof value === 'number') {
    return (_addr, index) => index < value;
  }
  return proxyaddr.compile(value.split(',').map((entry) => entry.trim()));
}

// Resolved once at module load: TRUST_PROXY is read from the environment at
// process start and never changes at runtime. The logging callback is a
// deliberate no-op — main.ts already warns once for the SAME value when it
// configures Express's own `trust proxy` setting; a second identical warning
// from this module would just be noise.
const trustFn = compileTrust(
  resolveTrustProxyValue(process.env.TRUST_PROXY, () => {}),
);

/**
 * Resolve the real client IP for a connection that never passes through
 * Express (a raw socket.io/engine.io handshake), applying the SAME
 * `TRUST_PROXY`-derived trust Express's `req.ip` uses.
 *
 * Why this exists: engine.io's `handshake.address` comes straight from
 * `req.connection.remoteAddress` (see engine.io's `Socket` constructor) — it
 * has NO knowledge of Express's `trust proxy` setting or `X-Forwarded-For`.
 * Behind a reverse proxy (nginx/ELB/Cloudflare — the exact topology
 * `TRUST_PROXY` exists for), every socket.io connection's raw peer is the
 * proxy, not the client, so keying anything per-IP off `handshake.address`
 * directly collapses every real client behind that proxy into one shared
 * bucket.
 */
export function resolveClientIp(
  headers: Record<string, unknown>,
  rawRemoteAddress: string,
): string {
  if (!trustFn) {
    return rawRemoteAddress;
  }
  return proxyaddr(
    { headers, socket: { remoteAddress: rawRemoteAddress } },
    trustFn,
  );
}

import 'dotenv/config';
import WebSocket from 'ws';

/**
 * One-shot relay reachability probe for the whole Jest run.
 *
 * Relay-backed integration specs must auto-skip when no `groups_relay` is up, and
 * the skip must be one Jest *counts* — which means the specs need the answer
 * synchronously, at collection time. A per-spec `await relayReachable()` can only
 * run in `beforeAll`, after tests are already registered, so it can at best make a
 * test silently no-op (reported as passed). Probing once here and exporting the
 * result via `process.env` (inherited by every worker) lets each spec pick
 * `describe`/`describe.skip` up front, so an absent relay shows as `N skipped`.
 *
 * `dotenv/config` above loads the repo `.env` into this (main) process so the
 * resolved `TG_RELAY_URL` — and the probe result — propagate to the workers.
 */
export default async function globalSetup(): Promise<void> {
  if (
    typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined'
  ) {
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  }

  const { relayReachable, RELAY_URL } = await import('./relay');
  // Pin the resolved URL so workers probe/report the same endpoint regardless of
  // each spec's own `import 'dotenv/config'` ordering.
  process.env.TG_RELAY_URL = RELAY_URL;

  const reachable = await relayReachable(RELAY_URL);
  process.env.TGR_RELAY_REACHABLE = reachable ? '1' : '';

  if (!reachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `[harness] no relay reachable at ${RELAY_URL} — relay-backed integration specs will skip`,
    );
  }
}

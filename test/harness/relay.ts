import { Relay } from 'nostr-tools';

/**
 * Local relay fixture helper for relay-backed integration specs (Task 02 harness).
 *
 * During local runs a NIP-29 relay (`groups_relay` / strfry29) listens at
 * `ws://localhost:7777` (override with `TG_RELAY_URL`). Relay-backed specs must
 * **auto-skip** when it is unreachable so unit-only / no-container CI stays green.
 *
 * This centralizes the `relayReachable` probe + the relay-admin keypair that was
 * copy-pasted across `relay-subscriber`, `relay-writer`, `room-admins`,
 * `membership-sync` specs. New relay-backed specs should import from here instead
 * of redefining it. (Existing specs already auto-skip correctly and are not
 * rewritten — see the harness README.)
 */

/** Default relay URL for local runs; overridable via env. */
export const RELAY_URL = process.env.TG_RELAY_URL || 'ws://localhost:7777';

/**
 * The relay-admin keypair (D7: the bot key under test == the relay admin so it
 * may create managed groups on a freshly-booted relay). Defaults to the
 * `groups_relay/config/settings.test.yml` pair; override via `TG_BOT_NSEC`.
 */
export const RELAY_ADMIN_NSEC =
  process.env.TG_BOT_NSEC ||
  'nsec1dwg3l5mumawgr4xq4kc6klagytkj2w4s4kd2rrthy47g3v5mwx8qwrh7sx';

/**
 * Probe whether a relay is reachable at `url`. Connects, immediately closes, and
 * never throws — returns `false` on any failure so specs can `describe.skip`.
 * A bounded timeout keeps a dead/wrong port from hanging the suite.
 */
export async function relayReachable(
  url: string = RELAY_URL,
  timeoutMs = 3000,
): Promise<boolean> {
  let relay: Relay | undefined;
  try {
    relay = await Promise.race([
      Relay.connect(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('relay connect timeout')), timeoutMs),
      ),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    try {
      relay?.close();
    } catch {
      // ignore — best-effort close
    }
  }
}

/**
 * Resolve a `describe`/`describe.skip` for relay-backed specs: skips unless a
 * relay is reachable (or `TG_RELAY_URL` was explicitly set, signalling an
 * external relay the caller vouches for).
 *
 * ```ts
 * let d = describe.skip;
 * beforeAll(async () => { d = await relayDescribe(); });
 * ```
 *
 * Because Jest needs the `describe` synchronously, most specs instead gate
 * individual relay cases at runtime with `relayReachable()` inside `beforeAll`;
 * this helper is for new specs that prefer a top-level gate.
 */
export async function relayDescribe(
  url: string = RELAY_URL,
): Promise<jest.Describe> {
  const reachable = !!process.env.TG_RELAY_URL || (await relayReachable(url));
  if (!reachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `[harness/relay] skipping relay-backed cases — no relay at ${url}`,
    );
  }
  return reachable ? describe : describe.skip;
}

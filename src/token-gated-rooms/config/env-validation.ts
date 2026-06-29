/**
 * Relay-enable predicate for the token-gated-rooms feature.
 *
 * Worker mode is gone (see `deworker-plan.md` DW2): TGR runs in ONE always-on
 * process and the relay-actuator duties self-enable iff a relay is configured.
 * There is no longer a fail-fast on missing OR invalid relay vars — a missing var,
 * or a `TG_BOT_NSEC` that isn't a valid bech32 `nsec1…`, simply leaves the relay
 * duties dormant (the public API + indexer still boot; the actuators decode the
 * nsec defensively and log loudly on failure rather than crashing). This module
 * re-exports the canonical predicate from `tgr.config` so existing import sites
 * keep working.
 */
export { isRelayConfigured } from './tgr.config';

/** Env vars that enable the relay-actuator duties when both are present. */
export const RELAY_ENV = ['TG_RELAY_URL', 'TG_BOT_NSEC'] as const;

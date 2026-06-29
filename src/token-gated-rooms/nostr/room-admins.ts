/**
 * Pure parse / normalize / exemption / diff helpers for the configured
 * `TG_ROOM_ADMINS` set (Task 08, D9, plan §6.7).
 *
 * Kept Nest-free (no DI, no I/O) so the parse/normalize, exemption predicate and
 * converge-diff are unit-testable in isolation and reusable on the hot path. The
 * worker-side {@link RoomAdminsService} and the startup
 * {@link RelayAdminHealthService} compose these; Task 10 consumes
 * {@link isConfiguredAdmin} for its balance-gating exemption.
 *
 * ## Config, not input (§10)
 * `TG_ROOM_ADMINS` is reviewed, version-controlled config — a comma-separated
 * list of **nostr pubkeys** (`npub1…` bech32 OR 64-char hex), NOT aeternity
 * addresses and NOT user input. Every value that leaves this module is a
 * lowercase 64-hex pubkey ({@link HEX64}); a malformed entry is a startup
 * configuration error and {@link parseRoomAdmins} THROWS (never silently skips)
 * so a bad list is caught once at boot, not per-room.
 */

import { HEX64, normalizePubkey } from './pubkey';

export { HEX64 } from './pubkey';

/** Thrown when `TG_ROOM_ADMINS` contains an entry that is neither npub nor 64-hex. */
export class RoomAdminConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomAdminConfigError';
  }
}

/**
 * Parse + normalize the configured room-admin list into a de-duplicated array of
 * lowercase 64-hex pubkeys.
 *
 * Accepts either the raw comma-separated env string OR an already-split array
 * (the config layer's `parseList` produces the latter as `config.nostrRoomAdmins`).
 *
 * - trims whitespace, ignores empty entries;
 * - normalizes each entry via {@link normalizePubkey} (npub→hex, hex→lowercased);
 * - de-duplicates (an npub and its hex form collapse to one);
 * - THROWS {@link RoomAdminConfigError} naming the first unparseable entry;
 * - empty / unset input → `[]` (rooms then have only the bot/creator as admin;
 *   this is NOT an error).
 */
export function parseRoomAdmins(
  input: string | readonly string[] | null | undefined,
): string[] {
  const rawEntries: string[] =
    input == null
      ? []
      : Array.isArray(input)
        ? (input as readonly string[]).slice()
        : String(input).split(',');

  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of rawEntries) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed === '') {
      // Ignore empty entries (trailing comma, blank slot) — not an error.
      continue;
    }
    const hex = normalizePubkey(trimmed);
    if (!hex) {
      throw new RoomAdminConfigError(
        `TG_ROOM_ADMINS contains an unparseable nostr pubkey: "${trimmed}" ` +
          `(expected an npub1… or 64-char hex)`,
      );
    }
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
    }
  }

  return out;
}

/**
 * `true` iff `pubkey` (hex or npub) normalizes to one of the configured room
 * admins. Format-insensitive: an npub and its hex form both match. A malformed /
 * unparseable input is never a configured admin (`false`).
 *
 * Task 10 consumes this as the **balance-gating exemption predicate**: a
 * configured admin must NOT be `9001`-removed on balance/eligibility loss — they
 * are admins, not balance-gated members.
 */
export function isConfiguredAdmin(
  pubkey: string | null | undefined,
  configuredHex: readonly string[],
): boolean {
  const hex = normalizePubkey(pubkey);
  if (!hex) {
    return false;
  }
  for (const admin of configuredHex) {
    if (admin === hex) {
      return true;
    }
  }
  return false;
}

/** The add/demote actions {@link diffRoomAdmins} computes for a single room. */
export interface RoomAdminDiff {
  /** Configured admins not yet admin on the relay → publish `9000` role=admin. */
  toPromote: string[];
  /** Relay admins no longer configured → publish `9006` set-roles=member (or `9001`). */
  toDemote: string[];
}

/**
 * Diff the configured admin set against the relay's CURRENT admin set (read from
 * the relay-served `39001`, lowercased hex) for one group.
 *
 * - `toPromote` = configured − current  (admins to add/promote, role=admin).
 * - `toDemote`  = current − configured  (admins to demote/remove), **excluding**
 *   the bot key, which is the creator + relay admin (§10) and always remains
 *   admin — so the relay's last-admin guard (`group.rs` set_roles 846–851) is
 *   never hit in normal operation.
 *
 * Equal sets (modulo the always-retained bot key) → both lists empty (no
 * publishes). Inputs are normalized defensively so a caller passing npub or
 * mixed-case hex still diffs correctly. Pure: no I/O, no publishes.
 *
 * @param configured normalized configured admin hex (output of {@link parseRoomAdmins}).
 * @param current the relay's current admin pubkeys (hex/npub; normalized here).
 * @param botPubkey the bot/relay-admin pubkey (hex); never demoted. Optional.
 */
export function diffRoomAdmins(
  configured: readonly string[],
  current: readonly string[],
  botPubkey?: string | null,
): RoomAdminDiff {
  const configuredSet = toHexSet(configured);
  const currentSet = toHexSet(current);
  const botHex = normalizePubkey(botPubkey);

  const toPromote: string[] = [];
  for (const hex of configuredSet) {
    if (!currentSet.has(hex)) {
      toPromote.push(hex);
    }
  }

  const toDemote: string[] = [];
  for (const hex of currentSet) {
    // Never demote the bot/relay-admin key (creator + relay admin, §10): keeping
    // it admin guarantees the relay's last-admin guard is not tripped.
    if (hex === botHex) {
      continue;
    }
    if (!configuredSet.has(hex)) {
      toDemote.push(hex);
    }
  }

  return { toPromote, toDemote };
}

/** Normalize a list of pubkeys (hex/npub) into a de-duped Set of lowercase hex. */
function toHexSet(values: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const value of values) {
    const hex = normalizePubkey(value);
    if (hex) {
      set.add(hex);
    }
  }
  return set;
}

/** Re-exported so call sites validating raw hex share one regex (= identity §6.6). */
export { normalizePubkey } from './pubkey';

/** Sanity guard a value is HEX64 (used in tests / defensive asserts). */
export function isHex64(value: string): boolean {
  return HEX64.test(value);
}

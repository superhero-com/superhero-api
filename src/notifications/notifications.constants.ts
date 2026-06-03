import { createHash } from 'crypto';

/**
 * DI token for the multi-provider array of notification channels.
 * Adding a channel = appending its provider to this array (see NotificationsModule).
 */
export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

/**
 * Redis key builders. NOTE: ioredis applies a global `keyPrefix` (the network id,
 * see REDIS_CONFIG), so these are automatically namespaced per network.
 */
export const REDIS_KEYS = {
  /** SET of addresses that have at least one registered device (hot-path gate). */
  hasDevices: 'notif:has-devices',
  /** Idempotency marker for a (type:dedupKey) logical key. */
  dedup: (logicalKey: string) => `notif:dedup:${logicalKey}`,
  /** Short-lived ticketId -> push token map, for receipt-time token pruning. */
  ticketToken: (ticketId: string) => `notif:ticket:${ticketId}`,
} as const;

/**
 * Short, stable fingerprint of the Expo push token used inside signed messages.
 * SHA-256 truncated to 16 hex chars (64 bits) — enough collision resistance for
 * intent binding without bloating the user-facing message string.
 */
function tokenFingerprint(expoPushToken: string): string {
  return createHash('sha256').update(expoPushToken).digest('hex').slice(0, 16);
}

/**
 * Canonical hash of the preferences delta the user signs. Sort by `type` with
 * a byte-equivalent comparator (`<`/`>` on the JS strings), serialize as
 * `type=0|1` joined by `;`, SHA-256 hex.
 *
 * Type IDs MUST be pure printable ASCII (` ` < c ≤ `~`) — the catalog is
 * code-defined, so this is a hand-maintained invariant. Reason: JS string `<` is
 * a UTF-16 *code-unit* compare, not a true Unicode-codepoint compare; for
 * supplementary-plane characters (>= U+10000) the result diverges from what
 * other runtimes (Rust/Go/.NET) produce. ASCII-only avoids that pitfall AND
 * sidesteps `localeCompare`'s ICU-locale dependency, which a server under one
 * ICU locale and a mobile RN runtime under another can disagree on,
 * producing different SHA-256 outputs and a permanent 401 "Invalid signature".
 */
export function canonicalPreferencesHash(
  preferences: ReadonlyArray<{ type: string; enabled: boolean }>,
): string {
  const canonical = [...preferences]
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
    .map((p) => `${p.type}=${p.enabled ? '1' : '0'}`)
    .join(';');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The exact message a device signs to prove (a) control of `address` AND (b) possession
 * of the specific Expo push token being registered. Without the token binding, a signer
 * for ak_Atk could re-point an existing victim row to ak_Atk via the upsert on
 * `expo_push_token`.
 */
export function buildDeviceLinkMessage(
  address: string,
  expoPushToken: string,
  nonce: string,
): string {
  return `Superhero Notifications\nLink device ${tokenFingerprint(
    expoPushToken,
  )} to ${address}\nnonce: ${nonce}`;
}

/**
 * Intent-bound message for unlinking a device. Both the address and the token are
 * committed to the signature so a known-token attacker cannot DoS a victim's pushes.
 */
export function buildDeviceUnlinkMessage(
  address: string,
  expoPushToken: string,
  nonce: string,
): string {
  return `Superhero Notifications\nUnlink device ${tokenFingerprint(
    expoPushToken,
  )} from ${address}\nnonce: ${nonce}`;
}

/**
 * Intent-bound message for the preferences-update flow. The shared nonce table
 * is reused, but the message format is distinct so a signature captured for
 * device-link cannot be replayed against preferences (and vice versa). The body
 * hash commits the signature to the specific {type, enabled} delta — without it,
 * an attacker could replay a captured nonce+signature with a swapped payload.
 */
export function buildPreferencesUpdateMessage(
  address: string,
  nonce: string,
  preferences: ReadonlyArray<{ type: string; enabled: boolean }>,
): string {
  return `Superhero Notifications\nUpdate preferences for ${address}\nbody: ${canonicalPreferencesHash(
    preferences,
  )}\nnonce: ${nonce}`;
}

/** `ak_2sQwEr...wXyZ` -> shortened, human-readable form for notification copy. */
export function shortenAddress(address: string): string {
  if (!address || address.length <= 13) {
    return address;
  }
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

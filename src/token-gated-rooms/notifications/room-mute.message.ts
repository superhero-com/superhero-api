import { createHash } from 'crypto';

/**
 * Canonical hash of the room-mute body the user signs. Binds the signature to the
 * exact `(muted, mute_all)` delta so a captured nonce+sig cannot be replayed with
 * a swapped payload (mirrors `canonicalPreferencesHash`).
 *
 * `mute_all` is tri-state on the wire (`true` / `false` / omitted = "don't
 * touch"). We serialize the absent case distinctly (`-`) so a signature for
 * "set mute_all=false" cannot be replayed as "leave mute_all untouched" or vice
 * versa. ASCII-only tokens — same codepoint-ordering rationale as the prefs hash.
 */
export function canonicalRoomMuteHash(
  muted: boolean,
  muteAll?: boolean,
): string {
  const muteAllToken = muteAll === undefined ? '-' : muteAll ? '1' : '0';
  const canonical = `muted=${muted ? '1' : '0'};mute_all=${muteAllToken}`;
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Intent-bound message for the per-room mute flow (Task 13 Req 5). Distinct from
 * `buildPreferencesUpdateMessage` (different first/second lines) AND from the
 * device-link/unlink messages, so a signature captured for any other intent
 * cannot be replayed here. The `sale_address` and the body hash are committed to
 * the signature, so a sig for one room — or for a different `(muted, mute_all)` —
 * is rejected.
 *
 * Format (reproduce byte-for-byte on the client):
 *   Superhero Rooms
 *   Mute <saleAddress> for <address>
 *   body: <sha256(muted|mute_all)>
 *   nonce: <nonce>
 */
export function buildRoomMuteMessage(
  address: string,
  nonce: string,
  saleAddress: string,
  muted: boolean,
  muteAll?: boolean,
): string {
  return `Superhero Rooms\nMute ${saleAddress} for ${address}\nbody: ${canonicalRoomMuteHash(
    muted,
    muteAll,
  )}\nnonce: ${nonce}`;
}

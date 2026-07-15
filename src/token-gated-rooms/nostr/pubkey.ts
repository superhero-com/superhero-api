// Load only the nip19 submodule via the package "exports" subpath. Importing the
// `nostr-tools` entry pulls in @noble/curves (ESM-only), which ts-jest cannot
// transform; the subpath is pure bech32. `require()` (not `import`) because
// moduleResolution:node does not type-resolve the subpath, though Node + ts-jest
// resolve it fine at runtime. Same pattern as matrix-defi-bot's
// NostrVerifiedAccounts.
const nip19: {
  decode: (value: string) => { type: string; data: unknown };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('nostr-tools/nip19');

/**
 * Pure npub→hex normalization helpers for token-gated rooms (Task 05).
 *
 * Kept Nest-free so they are unit-testable in isolation and reusable on the hot
 * path. Mirrors `matrix-defi-bot`'s `NostrVerifiedAccounts.nostrValueToHex`
 * exactly: accept a 64-char lowercase hex pubkey **or** a NIP-19 `npub`, reject
 * everything else. Every value that leaves these helpers is guaranteed to match
 * {@link HEX64} — we never emit a non-hex pubkey downstream (Task 10 puts it in a
 * `9000` `p`-tag, so a malformed value would corrupt relay state).
 */

/** A normalized nostr pubkey: 64 lowercase hex chars. */
export const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Normalize a raw nostr link value (as stored verbatim in
 * `Account.links[<provider>]` by the reactive link sync — may be hex or npub)
 * into a lowercase 64-char hex pubkey.
 *
 * @returns the normalized hex pubkey, or `undefined` if the input is neither a
 *   valid 64-hex string nor a valid `npub`. The result is always `HEX64`-valid.
 */
export function normalizePubkey(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') {
    return undefined;
  }

  // Already a hex pubkey.
  if (HEX64.test(trimmed)) {
    return trimmed;
  }

  // Otherwise try to decode it as a NIP-19 npub; reject any other bech32 type
  // (nsec/note/nprofile/…) or garbage. nip19.decode throws on invalid input.
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'npub' && typeof decoded.data === 'string') {
      const hex = decoded.data.toLowerCase();
      // Defensive: never trust the decoder to hand back exactly 64 hex chars.
      return HEX64.test(hex) ? hex : undefined;
    }
  } catch {
    // not a valid npub / not bech32 — fall through to undefined.
  }

  return undefined;
}

/**
 * Strict alias used at call sites that semantically expect an npub but tolerate
 * hex. Identical behavior to {@link normalizePubkey}; kept as a named export so
 * the intent (decode-an-npub) reads clearly where it is used.
 */
export function npubToHex(
  value: string | null | undefined,
): string | undefined {
  return normalizePubkey(value);
}

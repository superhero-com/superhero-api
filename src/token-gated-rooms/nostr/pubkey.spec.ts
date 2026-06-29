import { HEX64, normalizePubkey, npubToHex } from './pubkey';

// nostr-tools/nip19 is mocked: the real module transitively pulls in @noble/*
// (ESM-only), which ts-jest can't transform (same reason matrix-defi-bot's
// NostrVerifiedAccounts.test.ts mocks it). The resolver only needs npub→hex, so
// a fixture mapping known npubs ↔ hex is enough to exercise normalizePubkey.
const HEX = 'a'.repeat(64);
const NPUB = 'npub1valid';
const NOTE = 'note1valid';

jest.mock('nostr-tools/nip19', () => ({
  decode: (value: string) => {
    if (value === NPUB || value === NPUB.toLowerCase()) {
      return { type: 'npub', data: HEX };
    }
    if (value === NOTE) {
      return { type: 'note', data: HEX };
    }
    throw new Error('invalid bech32');
  },
}));

describe('pubkey normalization (Task 05)', () => {
  describe('HEX64', () => {
    it('matches 64 lowercase hex chars only', () => {
      expect(HEX64.test('0'.repeat(64))).toBe(true);
      expect(HEX64.test('A'.repeat(64))).toBe(false); // uppercase
      expect(HEX64.test('a'.repeat(63))).toBe(false); // too short
      expect(HEX64.test('a'.repeat(65))).toBe(false); // too long
      expect(HEX64.test('g'.repeat(64))).toBe(false); // non-hex
    });
  });

  describe('normalizePubkey', () => {
    it('returns lowercased hex for a valid 64-hex input', () => {
      expect(normalizePubkey(HEX)).toBe(HEX);
    });

    it('lowercases an uppercase hex input', () => {
      expect(normalizePubkey('A'.repeat(64))).toBe('a'.repeat(64));
    });

    it('trims surrounding whitespace before matching hex', () => {
      expect(normalizePubkey(`  ${HEX}  `)).toBe(HEX);
    });

    it('decodes a valid npub to hex', () => {
      expect(normalizePubkey(NPUB)).toBe(HEX);
    });

    it('decodes an uppercase npub (lowercased first) to hex', () => {
      expect(normalizePubkey(NPUB.toUpperCase())).toBe(HEX);
    });

    it('returns undefined for garbage', () => {
      expect(normalizePubkey('not-a-pubkey')).toBeUndefined();
    });

    it('returns undefined for wrong-length hex', () => {
      expect(normalizePubkey('abc123')).toBeUndefined();
      expect(normalizePubkey('a'.repeat(63))).toBeUndefined();
      expect(normalizePubkey('a'.repeat(65))).toBeUndefined();
    });

    it('returns undefined for non-npub bech32 (e.g. note)', () => {
      expect(normalizePubkey(NOTE)).toBeUndefined();
    });

    it('returns undefined for empty / nullish input', () => {
      expect(normalizePubkey('')).toBeUndefined();
      expect(normalizePubkey('   ')).toBeUndefined();
      expect(normalizePubkey(null)).toBeUndefined();
      expect(normalizePubkey(undefined)).toBeUndefined();
    });

    it('never returns a value that fails HEX64', () => {
      for (const v of [HEX, NPUB, 'A'.repeat(64)]) {
        const out = normalizePubkey(v);
        expect(out).toBeDefined();
        expect(HEX64.test(out as string)).toBe(true);
      }
    });
  });

  describe('npubToHex (alias)', () => {
    it('behaves identically to normalizePubkey', () => {
      expect(npubToHex(NPUB)).toBe(normalizePubkey(NPUB));
      expect(npubToHex(HEX)).toBe(normalizePubkey(HEX));
      expect(npubToHex('garbage')).toBeUndefined();
    });
  });
});

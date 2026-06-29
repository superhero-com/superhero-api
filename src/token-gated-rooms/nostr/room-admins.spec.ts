import { nip19 } from 'nostr-tools';
import { putUser } from './nip29';
import {
  diffRoomAdmins,
  isConfiguredAdmin,
  isHex64,
  parseRoomAdmins,
  RoomAdminConfigError,
} from './room-admins';

/** A deterministic 64-hex pubkey for index `n`. */
const hex = (n: number): string =>
  (n.toString(16).padStart(2, '0') + 'a'.repeat(62)).slice(0, 64);

/** The npub bech32 form of a hex pubkey. */
const npub = (h: string): string => nip19.npubEncode(h);

describe('room-admins (pure)', () => {
  describe('parseRoomAdmins', () => {
    it('hex passthrough, lowercased', () => {
      const h = hex(1);
      expect(parseRoomAdmins(h.toUpperCase())).toEqual([h]);
    });

    it('npub → hex', () => {
      const h = hex(2);
      expect(parseRoomAdmins(npub(h))).toEqual([h]);
    });

    it('accepts a comma-separated string and an array form identically', () => {
      const a = hex(3);
      const b = hex(4);
      expect(parseRoomAdmins(`${a},${b}`)).toEqual([a, b]);
      expect(parseRoomAdmins([a, b])).toEqual([a, b]);
    });

    it('trims whitespace and ignores empty entries (trailing/blank slots)', () => {
      const a = hex(5);
      const b = hex(6);
      expect(parseRoomAdmins(` ${a} , , ${b} ,`)).toEqual([a, b]);
    });

    it('de-duplicates (npub and its hex collapse to one)', () => {
      const a = hex(7);
      expect(parseRoomAdmins(`${a},${npub(a)},${a.toUpperCase()}`)).toEqual([
        a,
      ]);
    });

    it('throws RoomAdminConfigError on a malformed entry (not a silent skip)', () => {
      const a = hex(8);
      expect(() => parseRoomAdmins(`${a},not-a-pubkey`)).toThrow(
        RoomAdminConfigError,
      );
      expect(() => parseRoomAdmins('deadbeef')).toThrow(/unparseable/i);
    });

    it('rejects a non-npub bech32 (e.g. an nsec) as malformed', () => {
      const sk = new Uint8Array(32).fill(1);
      const nsec = nip19.nsecEncode(sk);
      expect(() => parseRoomAdmins(nsec)).toThrow(RoomAdminConfigError);
    });

    it('empty / unset → []', () => {
      expect(parseRoomAdmins('')).toEqual([]);
      expect(parseRoomAdmins('   ')).toEqual([]);
      expect(parseRoomAdmins(undefined)).toEqual([]);
      expect(parseRoomAdmins(null)).toEqual([]);
      expect(parseRoomAdmins([])).toEqual([]);
    });

    it('every output entry is HEX64', () => {
      const out = parseRoomAdmins([hex(1), npub(hex(2)), hex(3)]);
      for (const o of out) {
        expect(isHex64(o)).toBe(true);
      }
    });
  });

  describe('isConfiguredAdmin (exemption predicate)', () => {
    const configured = [hex(10), hex(11)];

    it('true for a configured hex', () => {
      expect(isConfiguredAdmin(hex(10), configured)).toBe(true);
    });

    it('true for the npub form of a configured admin (format-insensitive)', () => {
      expect(isConfiguredAdmin(npub(hex(11)), configured)).toBe(true);
    });

    it('true for an upper-cased hex form', () => {
      expect(isConfiguredAdmin(hex(10).toUpperCase(), configured)).toBe(true);
    });

    it('false for a non-configured pubkey', () => {
      expect(isConfiguredAdmin(hex(99), configured)).toBe(false);
    });

    it('false for malformed / empty / null input', () => {
      expect(isConfiguredAdmin('garbage', configured)).toBe(false);
      expect(isConfiguredAdmin('', configured)).toBe(false);
      expect(isConfiguredAdmin(null, configured)).toBe(false);
      expect(isConfiguredAdmin(undefined, configured)).toBe(false);
    });
  });

  describe('diffRoomAdmins (converge)', () => {
    const bot = hex(0);

    it('configured ⊃ relay → promotes the missing ones', () => {
      const configured = [hex(1), hex(2), hex(3)];
      const current = [hex(1), bot];
      const { toPromote, toDemote } = diffRoomAdmins(configured, current, bot);
      expect(new Set(toPromote)).toEqual(new Set([hex(2), hex(3)]));
      expect(toDemote).toEqual([]);
    });

    it('relay ⊃ configured → demotes the no-longer-configured ones', () => {
      const configured = [hex(1)];
      const current = [hex(1), hex(2), hex(3), bot];
      const { toPromote, toDemote } = diffRoomAdmins(configured, current, bot);
      expect(toPromote).toEqual([]);
      expect(new Set(toDemote)).toEqual(new Set([hex(2), hex(3)]));
    });

    it('equal sets → no publishes', () => {
      const configured = [hex(1), hex(2)];
      const current = [hex(2), hex(1), bot];
      const diff = diffRoomAdmins(configured, current, bot);
      expect(diff.toPromote).toEqual([]);
      expect(diff.toDemote).toEqual([]);
    });

    it('never demotes the bot key even when it is not in the configured set', () => {
      // The bot is the relay admin (§10): it is the sole current admin but not
      // configured — it must NOT be demoted (last-admin guard).
      const configured: string[] = [];
      const current = [bot];
      const { toPromote, toDemote } = diffRoomAdmins(configured, current, bot);
      expect(toDemote).toEqual([]);
      expect(toPromote).toEqual([]);
    });

    it('normalizes npub/mixed-case inputs before diffing', () => {
      const configured = [npub(hex(1)), hex(2).toUpperCase()];
      const current = [hex(1), npub(bot)];
      const { toPromote, toDemote } = diffRoomAdmins(configured, current, bot);
      expect(toPromote).toEqual([hex(2)]);
      expect(toDemote).toEqual([]);
    });
  });

  describe('9000 admin event shape', () => {
    it('p tag is exactly ["p", <hex>, "admin"], kind 9000, h = group id', () => {
      const gid = 'ct_RoomAdmins1';
      const h = hex(42);
      const t = putUser(gid, h, 'admin');
      expect(t.kind).toBe(9000);
      expect(t.tags[0]).toEqual(['h', gid]);
      expect(t.tags[1]).toEqual(['p', h, 'admin']);
    });
  });
});

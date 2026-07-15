import {
  buildRoomMuteMessage,
  canonicalRoomMuteHash,
} from './room-mute.message';
import { buildPreferencesUpdateMessage } from '@/notifications/notifications.constants';

const ADDR = 'ak_member';
const SALE = 'ct_sale';
const NONCE = 'abcdef0123456789';

describe('room-mute.message', () => {
  describe('canonicalRoomMuteHash', () => {
    it('binds to the (muted, mute_all) tuple', () => {
      const a = canonicalRoomMuteHash(true, true);
      const b = canonicalRoomMuteHash(false, true);
      const c = canonicalRoomMuteHash(true, false);
      expect(a).not.toBe(b); // muted differs
      expect(a).not.toBe(c); // mute_all differs
    });

    it('distinguishes "mute_all omitted" from explicit true/false', () => {
      const omitted = canonicalRoomMuteHash(true, undefined);
      const explicitFalse = canonicalRoomMuteHash(true, false);
      const explicitTrue = canonicalRoomMuteHash(true, true);
      expect(omitted).not.toBe(explicitFalse);
      expect(omitted).not.toBe(explicitTrue);
    });

    it('is stable for the same inputs (hex sha256)', () => {
      expect(canonicalRoomMuteHash(true, undefined)).toBe(
        canonicalRoomMuteHash(true, undefined),
      );
      expect(canonicalRoomMuteHash(true, undefined)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('buildRoomMuteMessage', () => {
    it('produces the documented 4-line format', () => {
      const msg = buildRoomMuteMessage(ADDR, NONCE, SALE, true, undefined);
      expect(msg).toBe(
        `Superhero Rooms\nMute ${SALE} for ${ADDR}\nbody: ${canonicalRoomMuteHash(
          true,
          undefined,
        )}\nnonce: ${NONCE}`,
      );
    });

    it('is distinct from the preferences-update message (no cross-replay)', () => {
      const roomMsg = buildRoomMuteMessage(ADDR, NONCE, SALE, true, undefined);
      const prefMsg = buildPreferencesUpdateMessage(ADDR, NONCE, [
        { type: 'room-messages', enabled: false },
      ]);
      expect(roomMsg).not.toBe(prefMsg);
      // different first line / intent header
      expect(roomMsg.startsWith('Superhero Rooms')).toBe(true);
      expect(prefMsg.startsWith('Superhero Notifications')).toBe(true);
    });

    it('binds to the room — swapping saleAddress changes the message', () => {
      const a = buildRoomMuteMessage(ADDR, NONCE, 'ct_a', true, false);
      const b = buildRoomMuteMessage(ADDR, NONCE, 'ct_b', true, false);
      expect(a).not.toBe(b);
    });

    it('binds to the body — swapping muted changes the message', () => {
      const a = buildRoomMuteMessage(ADDR, NONCE, SALE, true, false);
      const b = buildRoomMuteMessage(ADDR, NONCE, SALE, false, false);
      expect(a).not.toBe(b);
    });
  });
});

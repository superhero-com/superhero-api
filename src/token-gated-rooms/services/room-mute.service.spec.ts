import { NotificationPreferencesService } from '@/notifications/services/notification-preferences.service';
import { RoomPreferencesService } from './room-preferences.service';
import { RoomMuteService, ROOM_MESSAGES_TYPE } from './room-mute.service';

const ADDR = 'ak_member';
const SALE = 'ct_sale';

describe('RoomMuteService', () => {
  let roomPrefs: jest.Mocked<
    Pick<RoomPreferencesService, 'setMuted' | 'isMuted'>
  >;
  let prefs: jest.Mocked<
    Pick<NotificationPreferencesService, 'applyPartial' | 'isEnabled'>
  >;
  let service: RoomMuteService;

  beforeEach(() => {
    roomPrefs = { setMuted: jest.fn(), isMuted: jest.fn() } as any;
    prefs = { applyPartial: jest.fn(), isEnabled: jest.fn() } as any;
    service = new RoomMuteService(roomPrefs as any, prefs as any);
  });

  describe('setMute', () => {
    it('upserts the per-room mute row', async () => {
      roomPrefs.isMuted.mockResolvedValue(true);
      prefs.isEnabled.mockResolvedValue(true);
      await service.setMute(ADDR, SALE, true);
      expect(roomPrefs.setMuted).toHaveBeenCalledWith(ADDR, SALE, true);
    });

    it('leaves the type-level switch untouched when mute_all is omitted', async () => {
      roomPrefs.isMuted.mockResolvedValue(true);
      prefs.isEnabled.mockResolvedValue(true);
      await service.setMute(ADDR, SALE, true);
      expect(prefs.applyPartial).not.toHaveBeenCalled();
    });

    it('delegates mute-all=true to applyPartial with enabled=false (opt-out)', async () => {
      roomPrefs.isMuted.mockResolvedValue(true);
      prefs.isEnabled.mockResolvedValue(false);
      await service.setMute(ADDR, SALE, true, true);
      expect(prefs.applyPartial).toHaveBeenCalledWith(ADDR, [
        { type: ROOM_MESSAGES_TYPE, enabled: false },
      ]);
    });

    it('delegates mute-all=false to applyPartial with enabled=true', async () => {
      roomPrefs.isMuted.mockResolvedValue(false);
      prefs.isEnabled.mockResolvedValue(true);
      await service.setMute(ADDR, SALE, false, false);
      expect(prefs.applyPartial).toHaveBeenCalledWith(ADDR, [
        { type: ROOM_MESSAGES_TYPE, enabled: true },
      ]);
    });

    it('returns the resulting state', async () => {
      roomPrefs.isMuted.mockResolvedValue(true);
      prefs.isEnabled.mockResolvedValue(false);
      const result = await service.setMute(ADDR, SALE, true, true);
      expect(result).toEqual({ muted: true, mute_all: true });
    });
  });

  describe('getMute', () => {
    it('defaults both flags to false when no rows exist', async () => {
      roomPrefs.isMuted.mockResolvedValue(false);
      prefs.isEnabled.mockResolvedValue(true); // type-level enabled => not mute_all
      expect(await service.getMute(ADDR, SALE)).toEqual({
        muted: false,
        mute_all: false,
      });
    });

    it('mute_all reflects the inverse of the type-level enabled flag', async () => {
      roomPrefs.isMuted.mockResolvedValue(false);
      prefs.isEnabled.mockResolvedValue(false); // type disabled => mute_all true
      expect(await service.getMute(ADDR, SALE)).toEqual({
        muted: false,
        mute_all: true,
      });
      expect(prefs.isEnabled).toHaveBeenCalledWith(ADDR, ROOM_MESSAGES_TYPE);
    });
  });
});

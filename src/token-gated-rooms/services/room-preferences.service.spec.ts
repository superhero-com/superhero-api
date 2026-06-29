import { Repository } from 'typeorm';
import { NotificationPreferencesService } from '@/notifications/services/notification-preferences.service';
import { RoomNotificationPreference } from '../entities/room-notification-preference.entity';
import { RoomPreferencesService } from './room-preferences.service';

describe('RoomPreferencesService', () => {
  const ADDR = 'ak_member';
  const SALE = 'ct_sale';
  const TYPE = 'room-membership';

  let repo: jest.Mocked<
    Pick<Repository<RoomNotificationPreference>, 'findOne' | 'upsert'>
  >;
  let prefs: jest.Mocked<Pick<NotificationPreferencesService, 'isEnabled'>>;
  let service: RoomPreferencesService;

  beforeEach(() => {
    repo = { findOne: jest.fn(), upsert: jest.fn() } as any;
    prefs = { isEnabled: jest.fn() } as any;
    service = new RoomPreferencesService(repo as any, prefs as any);
  });

  describe('isRoomEnabled', () => {
    it('returns false when the room is muted (per-room row muted=true)', async () => {
      repo.findOne.mockResolvedValue({
        muted: true,
      } as RoomNotificationPreference);
      expect(await service.isRoomEnabled(ADDR, TYPE, SALE)).toBe(false);
      // short-circuits before the type-level check
      expect(prefs.isEnabled).not.toHaveBeenCalled();
    });

    it('returns false when the type-level mute-all is off (even if not per-room muted)', async () => {
      repo.findOne.mockResolvedValue(null);
      prefs.isEnabled.mockResolvedValue(false);
      expect(await service.isRoomEnabled(ADDR, TYPE, SALE)).toBe(false);
      expect(prefs.isEnabled).toHaveBeenCalledWith(ADDR, TYPE);
    });

    it('returns true when neither per-room muted nor type-level muted', async () => {
      repo.findOne.mockResolvedValue({
        muted: false,
      } as RoomNotificationPreference);
      prefs.isEnabled.mockResolvedValue(true);
      expect(await service.isRoomEnabled(ADDR, TYPE, SALE)).toBe(true);
    });

    it('defaults to enabled when no rows exist anywhere', async () => {
      repo.findOne.mockResolvedValue(null);
      prefs.isEnabled.mockResolvedValue(true);
      expect(await service.isRoomEnabled(ADDR, TYPE, SALE)).toBe(true);
    });

    it('type-level mute-all suppresses ALL rooms', async () => {
      repo.findOne.mockResolvedValue(null); // not per-room muted in any room
      prefs.isEnabled.mockResolvedValue(false);
      expect(await service.isRoomEnabled(ADDR, TYPE, 'ct_a')).toBe(false);
      expect(await service.isRoomEnabled(ADDR, TYPE, 'ct_b')).toBe(false);
    });
  });

  describe('isMuted', () => {
    it('is false when no row exists (opt-out default)', async () => {
      repo.findOne.mockResolvedValue(null);
      expect(await service.isMuted(ADDR, SALE)).toBe(false);
    });

    it('reflects the row muted flag', async () => {
      repo.findOne.mockResolvedValue({
        muted: true,
      } as RoomNotificationPreference);
      expect(await service.isMuted(ADDR, SALE)).toBe(true);
    });
  });

  describe('setMuted', () => {
    it('upserts on the composite PK', async () => {
      await service.setMuted(ADDR, SALE, true);
      expect(repo.upsert).toHaveBeenCalledWith(
        { address: ADDR, sale_address: SALE, muted: true },
        { conflictPaths: ['address', 'sale_address'] },
      );
    });
  });
});

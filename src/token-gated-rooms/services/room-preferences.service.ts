import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationPreferencesService } from '@/notifications/services/notification-preferences.service';
import { RoomNotificationPreference } from '../entities/room-notification-preference.entity';

/**
 * Room-scoped notification preferences (Task 12, plan §7.2 / §4.4).
 *
 * Two distinct mute layers must BOTH be honored before a room push is sent:
 *   - **per-room mute** — a `room_notification_preference` row with `muted=true`
 *     for `(address, sale_address)` (default: no row = NOT muted, opt-out model);
 *   - **mute-all (type-level)** — the existing `NotificationPreference` switch for
 *     the notification's own type (`room-membership` for membership pushes,
 *     `room-messages` for message pushes), via {@link NotificationPreferencesService}.
 *
 * Chosen approach (R3a): a dedicated service so the shared 2-arg
 * `NotificationPreferencesService.isEnabled(address, type)` signature stays
 * untouched. The dispatch path (room-notify processor) calls
 * {@link isRoomEnabled} *before* `NotificationService.send`, which still applies
 * its own type-level chokepoint independently.
 *
 * Also owns the **write path** used by Task 13's HTTP controller (this task only
 * exposes {@link setMuted} / {@link isMuted}; it adds NO controller).
 */
@Injectable()
export class RoomPreferencesService {
  constructor(
    @InjectRepository(RoomNotificationPreference)
    private readonly repo: Repository<RoomNotificationPreference>,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  /**
   * Room-scoped enabled check used at the dispatch chokepoint: enabled iff the
   * member is NOT per-room muted for `(address, saleAddress)` AND the type-level
   * mute-all switch for `type` is on. Mute-all suppresses EVERY room for that type.
   */
  async isRoomEnabled(
    address: string,
    type: string,
    saleAddress: string,
  ): Promise<boolean> {
    if (await this.isMuted(address, saleAddress)) {
      return false;
    }
    return this.preferences.isEnabled(address, type);
  }

  /** True iff a `room_notification_preference` row exists with `muted=true`. */
  async isMuted(address: string, saleAddress: string): Promise<boolean> {
    const row = await this.repo.findOne({
      where: { address, sale_address: saleAddress },
    });
    return row ? row.muted : false;
  }

  /**
   * Upsert the per-room mute flag for `(address, saleAddress)`. The write path the
   * Task 13 controller calls; idempotent on the composite PK.
   */
  async setMuted(
    address: string,
    saleAddress: string,
    muted: boolean,
  ): Promise<void> {
    await this.repo.upsert(
      { address, sale_address: saleAddress, muted },
      { conflictPaths: ['address', 'sale_address'] },
    );
  }
}

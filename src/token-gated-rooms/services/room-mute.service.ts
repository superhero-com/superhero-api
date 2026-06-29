import { Injectable } from '@nestjs/common';
import { NotificationPreferencesService } from '@/notifications/services/notification-preferences.service';
import { RoomPreferencesService } from './room-preferences.service';
import { RoomMuteViewDto } from '../dto/room-mute.view.dto';

/** The type-level switch used for "mute-all room messages" (Task 12 catalog). */
export const ROOM_MESSAGES_TYPE = 'room-messages';

/**
 * Client-facing room-mute read/write (Task 13). Thin orchestration over the two
 * mute layers so the controller stays trivial:
 *   - **per-room mute** → Task 12's {@link RoomPreferencesService} (writes
 *     `room_notification_preference (address, sale_address) muted`, the exact row
 *     Task 12 reads at dispatch via `isRoomEnabled`);
 *   - **mute-all** → the type-level `room-messages` switch, via the existing
 *     {@link NotificationPreferencesService} (opt-out model: `enabled=false` ⇒ muted).
 *
 * No relay I/O, no queue enqueue, no notification send — mute is enforced at
 * dispatch time by Task 12. This service only persists the preference rows.
 */
@Injectable()
export class RoomMuteService {
  constructor(
    private readonly roomPreferences: RoomPreferencesService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  /**
   * Persist the per-room mute and, if `muteAll` was provided, toggle the
   * type-level `room-messages` switch through the existing prefs service. Returns
   * the resulting state. `muteAll === undefined` leaves the type-level switch
   * untouched.
   */
  async setMute(
    address: string,
    saleAddress: string,
    muted: boolean,
    muteAll?: boolean,
  ): Promise<RoomMuteViewDto> {
    await this.roomPreferences.setMuted(address, saleAddress, muted);
    if (muteAll !== undefined) {
      // opt-out model: enabled = !muted. Delegates to Task 12's catalog type.
      await this.preferences.applyPartial(address, [
        { type: ROOM_MESSAGES_TYPE, enabled: !muteAll },
      ]);
    }
    return this.getMute(address, saleAddress);
  }

  /**
   * Current `{ muted, mute_all }` for `(address, saleAddress)`. Both default to
   * `false` when no row exists (opt-out, mirroring `isEnabled`/`isMuted` defaults):
   *   - `muted`    = `room_notification_preference.muted` (default false);
   *   - `mute_all` = NOT `room-messages` enabled (default enabled ⇒ mute_all false).
   */
  async getMute(
    address: string,
    saleAddress: string,
  ): Promise<RoomMuteViewDto> {
    const [muted, typeEnabled] = await Promise.all([
      this.roomPreferences.isMuted(address, saleAddress),
      this.preferences.isEnabled(address, ROOM_MESSAGES_TYPE),
    ]);
    return { muted, mute_all: !typeEnabled };
  }
}

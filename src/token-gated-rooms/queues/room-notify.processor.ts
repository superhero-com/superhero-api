import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Encoded } from '@aeternity/aepp-sdk';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationService } from '@/notifications/core/notification.service';
import { DeviceService } from '@/notifications/services/device.service';
import { RoomMembershipEvent } from '../entities/room-membership-event.entity';
import { RoomMembershipNotification } from '../notifications/room-membership.notification';
import { RoomPreferencesService } from '../services/room-preferences.service';
import { ROOM_NOTIFY_QUEUE, type RoomNotifyJob } from './room-notify.types';

/**
 * Consumer for `worker:room-notify` (Task 12 / plan §7) — **WORKER PROCESS ONLY**.
 *
 * The heavy half of the membership-push path: for each enqueued
 * `(saleAddress, memberAddress, change)` it
 *   1. resolves the member's device(s) — SKIP if none registered (the holder has
 *      no app installed; this is a `no-channel` outcome, NOT a failure — only
 *      device-bearing addresses are reachable, by design);
 *   2. checks the room-scoped preference — SKIP when the member is per-room muted
 *      (`room_notification_preference.muted=true` for `(address, saleAddress)`) OR
 *      the type-level `room-membership` mute-all is off
 *      (`NotificationPreferencesService.isEnabled` via {@link RoomPreferencesService});
 *   3. resolves the room symbol (best-effort) for nicer copy;
 *   4. dispatches via {@link NotificationService} (which re-applies its own
 *      type-level chokepoint independently).
 *
 * It NEVER throws past Bull's retry contract for a benign skip; only genuine
 * dispatch errors propagate (so Bull retries per the job options).
 */
@Processor(ROOM_NOTIFY_QUEUE)
export class RoomNotifyProcessor {
  private readonly logger = new Logger(RoomNotifyProcessor.name);

  constructor(
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    @InjectRepository(RoomMembershipEvent)
    private readonly eventRepo: Repository<RoomMembershipEvent>,
    private readonly devices: DeviceService,
    private readonly roomPreferences: RoomPreferencesService,
    private readonly notifications: NotificationService,
  ) {}

  @Process()
  async process(job: Job<RoomNotifyJob>): Promise<void> {
    const { saleAddress, memberAddress, change, accessEventId, isFirstGrant } =
      job.data;
    if (!saleAddress || !memberAddress || !change) {
      return;
    }

    // (0) Durable dedup: if this access-ledger event was already pushed (Bull
    // retry / redelivery after a restart), do not push it again.
    if (accessEventId && (await this.alreadyNotified(accessEventId))) {
      return;
    }

    // (1) Device-token reality: only addresses with a registered device are
    // reachable. No device → no push (not a failure).
    const tokens = await this.devices.getActiveTokens(memberAddress);
    if (tokens.length === 0) {
      return;
    }

    // (2) Room-scoped mute: per-room muted OR type-level mute-all both suppress.
    const enabled = await this.roomPreferences.isRoomEnabled(
      memberAddress,
      RoomMembershipNotification.META.type,
      saleAddress,
    );
    if (!enabled) {
      return;
    }

    // (3) Best-effort room label for copy (re-queried, never trust a stale event).
    const symbol = await this.resolveSymbol(saleAddress);

    // (4) Dispatch (NotificationService re-applies the type-level chokepoint).
    const outcome = await this.notifications.send(
      { address: memberAddress as Encoded.AccountAddress },
      new RoomMembershipNotification({
        saleAddress,
        symbol,
        change,
        isFirstGrant,
      }),
    );
    if (outcome.outcome === 'failed') {
      this.logger.warn(
        `room-membership notification failed for ${memberAddress} in ${saleAddress}: ${outcome.error}`,
      );
      return;
    }

    // (5) Stamp the ledger event dispatched (durable dedup). Best-effort — a stamp
    // failure must not fail the job (it would only risk a duplicate push).
    if (accessEventId) {
      await this.markNotified(accessEventId);
    }
  }

  /** True iff the access-ledger event has already been dispatched. */
  private async alreadyNotified(accessEventId: string): Promise<boolean> {
    try {
      const event = await this.eventRepo.findOne({
        where: { id: accessEventId },
        select: ['id', 'notified_at'],
      });
      return !!event?.notified_at;
    } catch {
      // Fail open: a lookup blip should not silently swallow the notification.
      return false;
    }
  }

  /** Stamp `notified_at=now()` on the access-ledger event (best-effort). */
  private async markNotified(accessEventId: string): Promise<void> {
    try {
      await this.eventRepo.update(
        { id: accessEventId },
        { notified_at: new Date() },
      );
    } catch (error) {
      this.logger.warn(
        `failed to stamp notified_at for access event ${accessEventId}: ${
          (error as Error).message
        }`,
      );
    }
  }

  /** Resolve the token symbol for nicer copy; undefined when unknown. */
  private async resolveSymbol(
    saleAddress: string,
  ): Promise<string | undefined> {
    try {
      const token = await this.tokenRepo.findOne({
        where: { sale_address: saleAddress },
        select: ['sale_address', 'symbol'],
      });
      return token?.symbol ?? undefined;
    } catch {
      return undefined;
    }
  }
}

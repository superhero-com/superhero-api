import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Encoded } from '@aeternity/aepp-sdk';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationService } from '@/notifications/core/notification.service';
import { DeviceService } from '@/notifications/services/device.service';
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
    private readonly devices: DeviceService,
    private readonly roomPreferences: RoomPreferencesService,
    private readonly notifications: NotificationService,
  ) {}

  @Process()
  async process(job: Job<RoomNotifyJob>): Promise<void> {
    const { saleAddress, memberAddress, change } = job.data;
    if (!saleAddress || !memberAddress || !change) {
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
      new RoomMembershipNotification({ saleAddress, symbol, change }),
    );
    if (outcome.outcome === 'failed') {
      this.logger.warn(
        `room-membership notification failed for ${memberAddress} in ${saleAddress}: ${outcome.error}`,
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

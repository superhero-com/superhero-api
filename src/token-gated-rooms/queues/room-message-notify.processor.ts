import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Encoded } from '@aeternity/aepp-sdk';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationService } from '@/notifications/core/notification.service';
import { DeviceService } from '@/notifications/services/device.service';
import { RoomMessageNotification } from '../notifications/room-message.notification';
import { RoomPreferencesService } from '../services/room-preferences.service';
import {
  ROOM_MESSAGE_NOTIFY_JOB,
  ROOM_NOTIFY_QUEUE,
  type RoomMessageNotifyJob,
} from './room-message-notify.types';

/**
 * Consumer of the **`room-message`-named** jobs on `worker:room-notify` (Task 14,
 * plan §7.1) — **WORKER PROCESS ONLY**.
 *
 * Sibling to Task 12's {@link RoomNotifyProcessor} (which owns the *unnamed* default
 * job = membership pushes) on the SAME queue: Bull routes by job name, so this
 * named `@Process('room-message')` only sees the message-notification jobs the
 * relay subscriber enqueues. Keeping both on one queue means the §7.1 circuit
 * breaker measures a single shared depth.
 *
 * Per job (the heavy half of the message-push path — cheap checks already done by
 * the subscriber on the hot path):
 *   1. resolve the recipient's device(s) — SKIP if none (the holder has no app;
 *      a `no-channel` outcome, NOT a failure — mirror `chain-transfer.listener.ts`);
 *   2. re-check the room-scoped mute (`RoomPreferencesService.isRoomEnabled` —
 *      per-room `room_notification_preference.muted` OR the type-level
 *      `room-messages` switch) so a mute toggled between enqueue and delivery is
 *      still honored before we build the notification;
 *   3. re-resolve the room symbol (never trust the queued snapshot);
 *   4. dispatch the coalesced {@link RoomMessageNotification} via
 *      {@link NotificationService} (which re-applies its own type-level chokepoint).
 *
 * It NEVER throws on a benign skip and logs (never throws) on a `failed`
 * `SendOutcome`. NOTE (Task 12 dependency): `RoomMessageNotification` renders a
 * generic "new messages" body — it does NOT yet accept `message_count` to render
 * the "N new messages in $SYM" copy required by §4. The coalesced count is carried
 * on the job for when Task 12's class gains a count param; today it only salts the
 * dedup key via `messageKey`. See the manifest notes.
 */
@Processor(ROOM_NOTIFY_QUEUE)
export class RoomMessageNotifyProcessor {
  private readonly logger = new Logger(RoomMessageNotifyProcessor.name);

  constructor(
    @InjectRepository(Token)
    private readonly tokenRepo: Repository<Token>,
    private readonly devices: DeviceService,
    private readonly roomPreferences: RoomPreferencesService,
    private readonly notifications: NotificationService,
  ) {}

  @Process({
    name: ROOM_MESSAGE_NOTIFY_JOB,
    // Conservative, like the publish path: a small cap so message fan-out never
    // starves the indexer / publish workers (TG_PUBLISH_CONCURRENCY semantics, §5).
    concurrency: 2,
  })
  async process(job: Job<RoomMessageNotifyJob>): Promise<void> {
    const data = job.data ?? ({} as RoomMessageNotifyJob);
    const {
      sale_address,
      recipient,
      symbol,
      window_started_at,
      sample_event_id,
    } = data;
    if (!sale_address || !recipient) {
      return;
    }

    // (1) Device-token reality: only addresses with a registered device are
    // reachable. No device → no push (not a failure).
    const tokens = await this.devices.getActiveTokens(recipient);
    if (tokens.length === 0) {
      return;
    }

    // (2) Room-scoped mute re-check (honor a mute toggled after enqueue).
    const enabled = await this.roomPreferences.isRoomEnabled(
      recipient,
      RoomMessageNotification.META.type,
      sale_address,
    );
    if (!enabled) {
      return;
    }

    // (3) Best-effort fresh room label (fall back to the queued symbol).
    const freshSymbol = (await this.resolveSymbol(sale_address)) ?? symbol;

    // (4) Dispatch the coalesced push. `messageKey` keys the dedup key off this
    // coalescing window so successive windows for the same (room, recipient) are
    // distinct pushes, but a re-delivered job within a window is deduped.
    const outcome = await this.notifications.send(
      { address: recipient as Encoded.AccountAddress },
      new RoomMessageNotification({
        saleAddress: sale_address,
        symbol: freshSymbol,
        messageKey: this.messageKey(window_started_at, sample_event_id),
      }),
    );
    if (outcome.outcome === 'failed') {
      this.logger.warn(
        `room-message notification failed for ${recipient} in ${sale_address}: ${outcome.error}`,
      );
    }
  }

  /** Per-window dedup salt: prefer the window start, fall back to a sample id. */
  private messageKey(
    windowStartedAt: number | undefined,
    sampleEventId: string | undefined,
  ): string | undefined {
    if (typeof windowStartedAt === 'number' && windowStartedAt > 0) {
      return `w${windowStartedAt}`;
    }
    return sampleEventId || undefined;
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

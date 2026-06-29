import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bull';
import notificationsConfig from '@/notifications/notifications.config';
import { NotificationRedisService } from '@/notifications/services/notification-redis.service';
import tgrConfig from '../config/tgr.config';
import {
  TGR_MEMBERSHIP_CHANGED,
  type TgrMembershipChangedPayload,
} from '../events';
import type { RoomMembershipChange } from '../notifications/room-membership.notification';
import {
  ROOM_NOTIFY_QUEUE,
  roomNotifyJobOptions,
  type RoomNotifyJob,
} from '../queues/room-notify.types';

/**
 * Bridges the in-process `tgr.membership.changed` event into the membership-push
 * pipeline — **WORKER PROCESS ONLY** (Task 12, plan §7).
 *
 * ## Why worker-only
 * `tgr.membership.changed` is emitted by `MembershipSyncService` in the WORKER
 * process on the relay-ACK seam. `@nestjs/event-emitter` (EventEmitter2) is
 * **in-process only** — a listener in the main API container would NEVER fire.
 * So this listener is registered as a worker-mode provider (see
 * `RoomNotificationsModule`).
 *
 * ## Pipeline
 * The listener is the cheap front of a two-stage path: it gates + throttles, then
 * ENQUEUES onto `worker:room-notify`. The `RoomNotifyProcessor` (also worker) does
 * the heavy lifting — device resolution + per-room/type mute checks + dispatch via
 * `NotificationService`. Keeping the device + mute checks in the processor means a
 * burst of membership flips never blocks the emitter on N DB round-trips.
 *
 * Gates applied here (in order, all best-effort / fail-open):
 *   1. notifications master kill-switch (`notificationsConfig.enabled`);
 *   2. **circuit-breaker** — if the `worker:room-notify` depth is past
 *      `roomNotifyDepthBreak` (§7.1), drop the event rather than pile on;
 *   3. **coalescing** — collapse repeated `(sale, member, change)` events within
 *      `msgCoalesceWindowSec` to one enqueue (SET NX marker);
 *   4. **per-recipient rate cap** — `msgRateCap`/`msgCoalesceWindowSec` fixed
 *      window (only when `msgRateCap > 0`; default 0 = off).
 *
 * The member's device + mute state are NOT checked here — that is the processor's
 * job (so the listener stays a thin, non-blocking front). It NEVER throws back into
 * the emitter.
 */
@Injectable()
export class RoomEventListener {
  private readonly logger = new Logger(RoomEventListener.name);

  constructor(
    @InjectQueue(ROOM_NOTIFY_QUEUE)
    private readonly roomNotifyQueue: Queue<RoomNotifyJob>,
    private readonly redis: NotificationRedisService,
    @Inject(tgrConfig.KEY)
    private readonly tgr: ConfigType<typeof tgrConfig>,
    @Inject(notificationsConfig.KEY)
    private readonly notifications: ConfigType<typeof notificationsConfig>,
  ) {}

  @OnEvent(TGR_MEMBERSHIP_CHANGED, { async: true, promisify: true })
  async onMembershipChanged(
    payload: TgrMembershipChangedPayload,
  ): Promise<void> {
    try {
      if (!this.notifications.enabled) {
        return;
      }
      const saleAddress = payload?.saleAddress;
      const memberAddress = payload?.memberAddress;
      const change = this.changeFor(payload?.relayState);
      if (!saleAddress || !memberAddress || !change) {
        // role transitions (relay_state still 'added'/'pending_*') and partial
        // payloads are not membership-add/remove pushes — ignore.
        return;
      }

      // (2) Circuit-breaker: shed load when the notify queue is backed up (§7.1).
      if (await this.isQueueOverDepth()) {
        this.logger.warn(
          `room-notify depth past ${this.tgr.roomNotifyDepthBreak}; dropping membership push for ${memberAddress} in ${saleAddress}`,
        );
        return;
      }

      // (3) Coalesce repeated (sale, member, change) within the window.
      if (
        !(await this.shouldEnqueueAfterCoalesce(
          saleAddress,
          memberAddress,
          change,
        ))
      ) {
        return;
      }

      // (4) Per-recipient rate cap (only when configured > 0).
      if (await this.isRateCapped(memberAddress)) {
        return;
      }

      await this.roomNotifyQueue.add(
        { saleAddress, memberAddress, change },
        roomNotifyJobOptions(),
      );
    } catch (error) {
      // Notifications must never break the emitter (membership-sync worker loop).
      this.logger.error(
        'Failed to process tgr.membership.changed for notification',
        error as Error,
      );
    }
  }

  /**
   * Map the thin event's `relay_state` to an add/remove membership change.
   * `'added'` → added; `'removed'`/`'pending_remove'` → removed; anything else
   * (e.g. a role transition that leaves the row `'added'`/`'pending_add'`) is not
   * a membership push.
   */
  private changeFor(
    relayState: TgrMembershipChangedPayload['relayState'] | undefined,
  ): RoomMembershipChange | null {
    if (relayState === 'added') {
      return 'added';
    }
    if (relayState === 'removed' || relayState === 'pending_remove') {
      return 'removed';
    }
    return null;
  }

  /** True iff the room-notify queue depth is past the circuit-breaker threshold. */
  private async isQueueOverDepth(): Promise<boolean> {
    try {
      const counts = await this.roomNotifyQueue.getJobCounts();
      const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0);
      return depth >= this.tgr.roomNotifyDepthBreak;
    } catch (error) {
      // Fail open: a depth-probe failure must not silently drop every push.
      this.logger.warn(
        `room-notify depth probe failed — failing open: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Coalesce window (§7): the first event for `(sale, member, change)` acquires a
   * SET NX marker (TTL = `msgCoalesceWindowSec`) and proceeds; repeats within the
   * window are dropped. A window of 0 disables coalescing (always enqueue).
   */
  private async shouldEnqueueAfterCoalesce(
    saleAddress: string,
    memberAddress: string,
    change: RoomMembershipChange,
  ): Promise<boolean> {
    const windowSec = this.tgr.msgCoalesceWindowSec;
    if (windowSec <= 0) {
      return true;
    }
    try {
      const key = `tgr:notify:coalesce:${saleAddress}:${memberAddress}:${change}`;
      return await this.redis.tryAcquire(key, windowSec * 1000);
    } catch (error) {
      // Fail open: a Redis blip should not silently swallow the notification.
      this.logger.warn(
        `coalesce check failed — failing open: ${(error as Error).message}`,
      );
      return true;
    }
  }

  /**
   * Per-recipient fixed-window rate cap (§7, `msgRateCap`). Off by default
   * (`msgRateCap=0`). Fail-open on Redis trouble (mirror the post-comment listener).
   */
  private async isRateCapped(memberAddress: string): Promise<boolean> {
    const cap = this.tgr.msgRateCap;
    if (cap <= 0) {
      return false;
    }
    const windowSec = Math.max(1, this.tgr.msgCoalesceWindowSec || 60);
    try {
      const { capped } = await this.redis.incrementWithCap(
        `tgr:notify:rate:${memberAddress}`,
        windowSec,
        cap,
      );
      if (capped) {
        this.logger.warn(
          `room-notify rate cap hit for ${memberAddress} (${cap}/${windowSec}s) — dropping until window resets`,
        );
      }
      return capped;
    } catch (error) {
      this.logger.warn(
        `room-notify rate-cap check failed for ${memberAddress} — failing open: ${(error as Error).message}`,
      );
      return false;
    }
  }
}

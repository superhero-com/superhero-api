import { Notifiable } from '@/notifications/core/notifiable.interface';
import {
  AppNotification,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '@/notifications/core/notification.interface';

/** Membership change this notification represents — drives copy + dedup key. */
export type RoomMembershipChange = 'added' | 'removed';

export interface RoomMembershipParams {
  /** `Token.sale_address` — the NIP-29 group id / room key. */
  saleAddress: string;
  /** Optional human room label (token symbol); falls back to a generic copy. */
  symbol?: string;
  /** Whether the holder was added to or removed from the room. */
  change: RoomMembershipChange;
  /**
   * For an `added` change: whether this is the member's first-ever access grant
   * (access-ledger plan). `true` → a "welcome" copy; `false` → a "you're back"
   * copy (access regained after a real lapse). Ignored for `removed`.
   */
  isFirstGrant?: boolean;
  /**
   * `room_membership_event.id` — the durable identity of THIS access transition
   * (access-ledger plan). When present it keys the dedup so distinct transitions
   * (e.g. a real regain within `NOTIF_DEDUP_TTL_MS`) never collapse onto an earlier
   * push; the Redis dedup then only collapses true duplicates (Bull re-delivery of
   * the same event), matching the `notified_at` guard. Falls back to the
   * (room, change, recipient) key when absent (non-ledger callers).
   */
  accessEventId?: string;
}

/**
 * "You were added to / removed from a token-gated room" — fired off the in-process
 * `tgr.membership.changed` event (Task 12), with **no relay read**. Membership
 * pushes are gated by the `room-membership` type switch (catalog) and the per-room
 * mute (`room_notification_preference`). This is the reference TGR notification:
 * copy `incoming-transfer.notification.ts`'s shape.
 */
export class RoomMembershipNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'room-membership',
    title: 'Room membership',
    description:
      "Notifies you when you're added to or removed from a token-gated room.",
  };

  readonly type = RoomMembershipNotification.META.type;
  readonly title = RoomMembershipNotification.META.title;
  readonly description = RoomMembershipNotification.META.description;

  constructor(private readonly params: RoomMembershipParams) {}

  via(): NotificationChannelName[] {
    return ['expo'];
  }

  dedupKey(notifiable: Notifiable): string {
    // Prefer the durable per-transition ledger id: distinct access transitions
    // (a grant, a later revoke, a real regain) each get a UNIQUE key, so the Redis
    // dedup only collapses true duplicates (Bull re-delivery of the SAME event) —
    // never two legitimate transitions that happen to fall within the dedup TTL.
    // This keeps the Redis backstop consistent with the ledger's `notified_at`
    // guard (both keyed on the event), so a Redis-suppressed send can never mark an
    // undelivered distinct transition as notified.
    if (this.params.accessEventId) {
      return `room-membership:${this.params.saleAddress}:evt:${this.params.accessEventId}:${notifiable.address}`;
    }
    // Fallback (non-ledger callers): per (room, change, recipient).
    return `room-membership:${this.params.saleAddress}:${this.params.change}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const room = this.params.symbol
      ? `the ${this.params.symbol} room`
      : 'a room';
    let body: string;
    if (this.params.change === 'added') {
      body =
        this.params.isFirstGrant === false
          ? `You're back in ${room}.`
          : `You now have access to ${room}.`;
    } else {
      body = `You no longer have access to ${room}.`;
    }
    return {
      title: 'Room access',
      body,
      data: {
        type: this.type,
        saleAddress: this.params.saleAddress,
        change: this.params.change,
      },
    };
  }
}

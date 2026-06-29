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
    // Distinct per (room, change, recipient): an add and a later remove never
    // collapse, while repeated adds for the same room collapse to one push.
    return `room-membership:${this.params.saleAddress}:${this.params.change}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const room = this.params.symbol
      ? `the ${this.params.symbol} room`
      : 'a room';
    const body =
      this.params.change === 'added'
        ? `You now have access to ${room}.`
        : `You no longer have access to ${room}.`;
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

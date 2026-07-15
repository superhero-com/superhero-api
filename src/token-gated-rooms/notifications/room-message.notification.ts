import { Notifiable } from '@/notifications/core/notifiable.interface';
import {
  AppNotification,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '@/notifications/core/notification.interface';

export interface RoomMessageParams {
  /** `Token.sale_address` — the NIP-29 group id / room key. */
  saleAddress: string;
  /** Optional human room label (token symbol); falls back to a generic copy. */
  symbol?: string;
  /**
   * Optional opaque per-message key used by the relay subscriber (Task 14) to keep
   * dedup keys distinct across coalesced new-message pushes (e.g. a coalescing
   * window id or the latest event id). Omitted → one push per (room, recipient).
   */
  messageKey?: string;
}

/**
 * "New messages in a token-gated room" — the notification **class** is owned and
 * defined here (Task 12) so the catalog is complete (`type: 'room-messages'`), but
 * the relay-read subscriber that FIRES it (dedup via `room_message_seen`,
 * coalescing, sharding) is Task 14. Task 12 only defines the class + its catalog
 * entry; it does not dispatch this notification.
 */
export class RoomMessageNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'room-messages',
    title: 'Room messages',
    description: 'Notifies you about new messages in a token-gated room.',
  };

  readonly type = RoomMessageNotification.META.type;
  readonly title = RoomMessageNotification.META.title;
  readonly description = RoomMessageNotification.META.description;

  constructor(private readonly params: RoomMessageParams) {}

  via(): NotificationChannelName[] {
    return ['expo'];
  }

  dedupKey(notifiable: Notifiable): string {
    // Room-scoped per recipient; an optional messageKey lets Task 14 distinguish
    // coalesced new-message pushes without re-defining this class.
    const suffix = this.params.messageKey ? `:${this.params.messageKey}` : '';
    return `room-messages:${this.params.saleAddress}:${notifiable.address}${suffix}`;
  }

  toExpo(): ExpoMessageContent {
    const room = this.params.symbol
      ? `the ${this.params.symbol} room`
      : 'a room';
    return {
      title: 'New messages',
      body: `There are new messages in ${room}.`,
      data: {
        type: this.type,
        saleAddress: this.params.saleAddress,
      },
    };
  }
}

import { Notifiable } from '../core/notifiable.interface';
import {
  AppNotification,
  DatabaseNotificationContent,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '../core/notification.interface';
import { shortenAddress } from '../notifications.constants';

export interface TipReceivedParams {
  /** Notification recipient — the tipped account. */
  receiver: string;
  /** Account that sent the tip. */
  sender: string;
  /** Already formatted in AE. */
  amountAe: string;
  /** Tipped post id for post tips; undefined for profile tips. */
  postId?: string;
  /** Tip tx hash, used as the dedup key. */
  txHash: string;
  /** Optional human label for the sender (chain name). */
  senderLabel?: string;
}

/**
 * "<X> tipped you N AE" / "<X> tipped your post N AE" — triggered when a tip
 * SpendTx (TIP_PROFILE / TIP_POST payload) is indexed live.
 */
export class TipReceivedNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'tip-received',
    title: 'Tips',
    description: 'Notifies you when someone tips you or one of your posts.',
  };

  readonly type = TipReceivedNotification.META.type;
  readonly title = TipReceivedNotification.META.title;
  readonly description = TipReceivedNotification.META.description;

  constructor(private readonly params: TipReceivedParams) {}

  // A tip is also a plain SpendTx, so mobile already gets the
  // incoming-transfer push for it. Web feed + browser push only, so a phone
  // never buzzes twice for one tip.
  via(): NotificationChannelName[] {
    return ['database', 'web-push'];
  }

  dedupKey(notifiable: Notifiable): string {
    // One notification per (tip tx, receiver) — guards retries / reorg replays.
    return `${this.params.txHash}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const who = this.params.senderLabel || shortenAddress(this.params.sender);
    const target = this.params.postId ? 'your post' : 'you';
    return {
      title: 'New tip',
      body: `${who} tipped ${target} ${this.params.amountAe} AE`,
      data: {
        type: this.type,
        txHash: this.params.txHash,
        sender: this.params.sender,
        amountAe: this.params.amountAe,
        ...(this.params.postId ? { postId: this.params.postId } : {}),
      },
    };
  }

  /** Feed copy mirrors the push; `data` carries the deep-link hints. */
  toDatabase(): DatabaseNotificationContent {
    return this.toExpo();
  }
}

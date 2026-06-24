import { Notifiable } from '../core/notifiable.interface';
import {
  AppNotification,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '../core/notification.interface';
import { shortenAddress } from '../notifications.constants';

export interface IncomingTransferParams {
  recipient: string;
  sender: string;
  /** Already formatted from aettos via toAe(). */
  amountAe: string;
  txHash: string;
  /** Optional human label for the sender (chain name); falls back to short address. */
  senderLabel?: string;
}

/**
 * "You received X AE from <sender>" — triggered on an incoming live SpendTx.
 * This is the reference notification: copy it to add new types.
 */
export class IncomingTransferNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'incoming-transfer',
    title: 'Incoming transfers',
    description: 'Notifies you when someone sends you AE.',
  };

  readonly type = IncomingTransferNotification.META.type;
  readonly title = IncomingTransferNotification.META.title;
  readonly description = IncomingTransferNotification.META.description;

  constructor(private readonly params: IncomingTransferParams) {}

  // Mobile push only. Incoming SpendTx are intentionally NOT persisted to the
  // web feed: they fire for every on-chain transfer to the recipient, so adding
  // 'database' here would write a feed row (and do the dispatch work) for every
  // transfer — exactly the cost the web feed must not pay. Expo stays gated on
  // the recipient having a registered device (see ChainTransferListener).
  via(): NotificationChannelName[] {
    return ['expo'];
  }

  dedupKey(notifiable: Notifiable): string {
    // One notification per (tx, recipient) — guards retries, double-observation, reorg replays.
    return `${this.params.txHash}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const from = this.params.senderLabel || shortenAddress(this.params.sender);
    return {
      title: 'Payment received',
      body: `You received ${this.params.amountAe} AE from ${from}`,
      data: {
        type: this.type,
        txHash: this.params.txHash,
        sender: this.params.sender,
        amountAe: this.params.amountAe,
      },
    };
  }
}

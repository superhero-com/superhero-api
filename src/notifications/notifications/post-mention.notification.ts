import { Notifiable } from '../core/notifiable.interface';
import {
  AppNotification,
  DatabaseNotificationContent,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '../core/notification.interface';
import { shortenAddress } from '../notifications.constants';

export interface PostMentionParams {
  /** Notification recipient — the tagged account. */
  mentioned: string;
  /** Account that wrote the post. */
  author: string;
  /** The mentioning post's id. */
  postId: string;
  /** Post tx hash, used as the dedup key. */
  txHash: string;
  /** Optional human label for the author (chain name). */
  authorLabel?: string;
}

/**
 * "<X> mentioned you in a post" — triggered when a live post tags the
 * recipient with the `[account:ak_…]` macro.
 */
export class PostMentionNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'post-mention',
    title: 'Mentions',
    description: 'Notifies you when someone mentions you in a post.',
  };

  readonly type = PostMentionNotification.META.type;
  readonly title = PostMentionNotification.META.title;
  readonly description = PostMentionNotification.META.description;

  constructor(private readonly params: PostMentionParams) {}

  via(): NotificationChannelName[] {
    return ['expo', 'database', 'web-push'];
  }

  dedupKey(notifiable: Notifiable): string {
    // One notification per (post tx, tagged account).
    return `${this.params.txHash}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const who = this.params.authorLabel || shortenAddress(this.params.author);
    return {
      title: 'New mention',
      body: `${who} mentioned you in a post`,
      data: {
        type: this.type,
        txHash: this.params.txHash,
        author: this.params.author,
        postId: this.params.postId,
      },
    };
  }

  /** Feed copy mirrors the push; `data` carries the deep-link hints. */
  toDatabase(): DatabaseNotificationContent {
    return this.toExpo();
  }
}

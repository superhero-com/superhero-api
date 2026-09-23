import { Notifiable } from '../core/notifiable.interface';
import {
  AppNotification,
  DatabaseNotificationContent,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '../core/notification.interface';
import { shortenAddress } from '../notifications.constants';

export interface NewFollowParams {
  graphScope?: { network: string; contract: string; eventIndex: number };
  /** Account that started following (notification subject). */
  follower: string;
  /** Account that was followed (notification recipient). */
  followed: string;
  /** Follow tx hash, used as the dedup key. */
  txHash: string;
  /** Optional human label for the follower (chain name); falls back to short address. */
  followerLabel?: string;
}

/**
 * "<X> started following you" — triggered when a new follow edge is indexed
 * from a live SocialContract Followed event.
 */
export class NewFollowNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'new-follow',
    title: 'New followers',
    description: 'Notifies you when someone starts following you.',
  };

  readonly type = NewFollowNotification.META.type;
  readonly title = NewFollowNotification.META.title;
  readonly description = NewFollowNotification.META.description;

  constructor(private readonly params: NewFollowParams) {}

  via(): NotificationChannelName[] {
    return ['expo', 'database', 'web-push'];
  }

  dedupKey(notifiable: Notifiable): string {
    // One notification per (follow tx, followed account) — guards retries / reorg replays.
    const scope = this.params.graphScope;
    return scope
      ? `${scope.network}:${scope.contract}:${this.params.txHash}:${scope.eventIndex}:${notifiable.address}`
      : `${this.params.txHash}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const who =
      this.params.followerLabel || shortenAddress(this.params.follower);
    return {
      title: 'New follower',
      body: `${who} started following you`,
      data: {
        type: this.type,
        txHash: this.params.txHash,
        follower: this.params.follower,
        ...(this.params.graphScope
          ? { graphScope: this.params.graphScope }
          : {}),
      },
    };
  }

  /** Feed copy mirrors the push for now; `data` carries the deep-link hints. */
  toDatabase(): DatabaseNotificationContent {
    return this.toExpo();
  }
}

import { Notifiable } from '../core/notifiable.interface';
import {
  AppNotification,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '../core/notification.interface';
import { shortenAddress } from '../notifications.constants';

export interface PostCommentParams {
  /** Notification recipient — the parent post's author. */
  postAuthor: string;
  /** The user who wrote the comment. */
  commenter: string;
  /** Parent post id (the one being commented on). */
  parentPostId: string;
  /** The comment post's id. */
  commentId: string;
  /** Comment tx hash, used as the dedup key. */
  txHash: string;
  /** Optional human label for the commenter (chain name). */
  commenterLabel?: string;
}

/**
 * "<X> commented on your post" — triggered when an existing post is reclassified
 * as a comment on a parent post the recipient authored.
 */
export class PostCommentNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'post-comment',
    title: 'Comments on your posts',
    description: 'Notifies you when someone comments on a post you authored.',
  };

  readonly type = PostCommentNotification.META.type;
  readonly title = PostCommentNotification.META.title;
  readonly description = PostCommentNotification.META.description;

  constructor(private readonly params: PostCommentParams) {}

  via(): NotificationChannelName[] {
    return ['expo'];
  }

  dedupKey(notifiable: Notifiable): string {
    // One notification per (comment tx, post author) — guards retries / reorg replays.
    return `${this.params.txHash}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    const who =
      this.params.commenterLabel || shortenAddress(this.params.commenter);
    return {
      title: 'New comment on your post',
      body: `${who} commented on your post`,
      data: {
        type: this.type,
        txHash: this.params.txHash,
        commenter: this.params.commenter,
        parentPostId: this.params.parentPostId,
        commentId: this.params.commentId,
      },
    };
  }
}

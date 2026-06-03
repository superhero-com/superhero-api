import { NotificationMeta } from './core/notification.interface';
import { IncomingTransferNotification } from './notifications/incoming-transfer.notification';
import { AnnouncementNotification } from './notifications/announcement.notification';
import { InvitationClaimedNotification } from './notifications/invitation-claimed.notification';
import { PostCommentNotification } from './notifications/post-comment.notification';

/**
 * Catalog of every notification type the user can opt into / out of. Source of
 * truth: each notification class's static `META`. Adding a new type = define the
 * class with its `META` and append a single entry here.
 *
 * Order matters — the mobile preferences screen renders rows in this order.
 *
 * Mirror this list (by id only) at
 * `superhero-api-admin/lib/notification-catalog.ts` when adding a new type, so
 * the admin's Subscribers detail page can label preference rows.
 */
export const NOTIFICATION_CATALOG: ReadonlyArray<NotificationMeta> = [
  IncomingTransferNotification.META,
  AnnouncementNotification.META,
  InvitationClaimedNotification.META,
  PostCommentNotification.META,
];

/** O(1) lookup used to whitelist incoming `type` strings in update payloads. */
export const NOTIFICATION_CATALOG_BY_TYPE: ReadonlyMap<
  string,
  NotificationMeta
> = new Map(NOTIFICATION_CATALOG.map((meta) => [meta.type, meta]));

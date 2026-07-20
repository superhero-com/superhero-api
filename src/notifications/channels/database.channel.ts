import { Injectable, Logger } from '@nestjs/common';
import { Notifiable } from '../core/notifiable.interface';
import { AppNotification } from '../core/notification.interface';
import { NotificationChannel } from '../core/notification-channel.interface';
import { NotificationFeedService } from '../services/notification-feed.service';
import { NotificationDedupService } from '../services/notification-dedup.service';
import { NotificationsGateway } from '../notifications.gateway';
import { toFeedItemView } from '../dto/feed-item.view.dto';

/**
 * Web in-app feed channel. Persists one `notifications` row per recipient (the
 * source of truth for the bell/history/unread badge), then emits that exact
 * persisted row to the recipient's socket room for a live update, followed by
 * the freshly-recomputed unread count (so the badge, not just the item list,
 * updates live — the same pairing `FeedController.markRead` already does).
 *
 * Order matters: persist FIRST, emit SECOND, so the realtime payload carries the
 * row id — the live item and the later feed fetch are the same object and the
 * frontend dedupes by id. The emit is best-effort: a socket on another replica
 * (no Redis adapter in v1) or simply no open tab just misses it, and the client
 * recovers the item (and the count) by listing the feed on its next (re)connect.
 *
 * Dedup is channel-namespaced (`database:…`) so it can't collide with the Expo
 * channel's marker for the same logical notification.
 */
@Injectable()
export class DatabaseChannel implements NotificationChannel {
  readonly name = 'database' as const;
  private readonly logger = new Logger(DatabaseChannel.name);

  constructor(
    private readonly feed: NotificationFeedService,
    private readonly dedup: NotificationDedupService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async send(
    notifiable: Notifiable,
    notification: AppNotification,
  ): Promise<void> {
    if (!notification.toDatabase) {
      // via() promised 'database' but the type can't render for it — a wiring
      // bug. Throw so the dispatcher logs it instead of silently dropping.
      throw new Error(
        `Notification "${notification.type}" routes to 'database' but has no toDatabase()`,
      );
    }

    const dedupKey = `${this.name}:${notification.type}:${notification.dedupKey(
      notifiable,
    )}`;
    const acquired = await this.dedup.tryAcquire(dedupKey);
    if (!acquired) {
      return;
    }

    let record;
    let unreadCount: number;
    try {
      // toDatabase() is rendered INSIDE this try — not just the write below —
      // so a throwing renderer (a template bug, a bad param) also releases the
      // marker we just acquired. Rendering it after tryAcquire but outside this
      // guarded region would leak the marker for the full dedupTtl on a throw,
      // same as the write-failure case this catch already exists to prevent.
      const content = notification.toDatabase(notifiable);
      ({ record, unreadCount } = await this.feed.recordAndCountUnread(
        notifiable.address,
        notification.type,
        content,
      ));
    } catch (error) {
      // The write failed (DB blip, connection pool exhaustion, …). Release the
      // marker we just acquired — otherwise it survives for the full dedupTtl
      // and, since most of these notifications are one-shot chain/social events
      // with no retry, a transient failure here would PERMANENTLY drop the row
      // instead of merely delaying it to the next observation.
      await this.dedup.release(dedupKey).catch((releaseError) => {
        this.logger.warn(
          `Failed to release dedup key "${dedupKey}" after a failed write: ${
            (releaseError as Error).message
          }`,
        );
      });
      throw error;
    }

    // Best-effort live delivery; never let an emit failure fail the channel
    // (the row is already persisted and will be picked up on next feed fetch).
    try {
      this.gateway.emitToAddress(notifiable.address, toFeedItemView(record));
      // Also push the authoritative unread badge. Without this, open tabs only
      // ever see 'unread-count' after a mark-read — a brand-new row bumps the
      // ITEM LIST live but leaves the badge stale until the next reconnect-
      // triggered refresh(). The client's 'unread-count' handler already exists
      // and is correct; it was simply never fed on new-item arrival. `unreadCount`
      // came back from the SAME statement as the insert (see
      // `recordAndCountUnread`) rather than a separate query, specifically so a
      // concurrent `FeedController.markRead()` can't complete its own,
      // fresher write+emit in the gap and then have THIS stale count overwrite
      // it when it emits later.
      this.gateway.emitUnreadCount(notifiable.address, unreadCount);
    } catch (error) {
      this.logger.warn(
        `Live emit failed for ${notifiable.address} (row ${record.id} persisted): ${
          (error as Error).message
        }`,
      );
    }
  }
}

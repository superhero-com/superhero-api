import { Notifiable } from '../core/notifiable.interface';
import {
  AppNotification,
  ExpoMessageContent,
  NotificationChannelName,
  NotificationMeta,
} from '../core/notification.interface';

export interface AnnouncementParams {
  id: number;
  title: string;
  description: string;
}

/**
 * An admin-authored announcement, delivered as a push. The announcement itself is
 * persisted in the `announcements` table (which backs the in-app feed); this class
 * only renders the push. `dedupKey` guarantees at-most-one push per recipient even
 * if a dispatch is somehow retried.
 */
export class AnnouncementNotification implements AppNotification {
  static readonly META: NotificationMeta = {
    type: 'announcement',
    title: 'Announcements',
    description: 'Updates and news from the Superhero team.',
  };

  readonly type = AnnouncementNotification.META.type;
  readonly title = AnnouncementNotification.META.title;
  readonly description = AnnouncementNotification.META.description;

  constructor(private readonly params: AnnouncementParams) {}

  via(): NotificationChannelName[] {
    return ['expo'];
  }

  dedupKey(notifiable: Notifiable): string {
    return `announcement:${this.params.id}:${notifiable.address}`;
  }

  toExpo(): ExpoMessageContent {
    return {
      title: this.params.title,
      body: this.params.description,
      data: {
        type: this.type,
        announcementId: this.params.id,
      },
    };
  }
}

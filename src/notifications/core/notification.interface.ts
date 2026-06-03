import { Notifiable } from './notifiable.interface';

export type NotificationChannelName = 'expo' | 'database' | 'websocket';

export interface ExpoMessageContent {
  title: string;
  body: string;
  /** Deep-link payload handed to the app on tap. */
  data?: Record<string, unknown>;
}

/**
 * Catalog metadata for a notification type — surfaces in the user's notification
 * settings screen via GET /notifications/:address/preferences. Distinct from the
 * runtime push content rendered in `toExpo()` (e.g. the category title is
 * "Incoming transfers"; the push title is "Payment received").
 */
export interface NotificationMeta {
  /** Stable machine key, e.g. 'incoming-transfer'. */
  readonly type: string;
  /** Human title for the settings screen, e.g. 'Incoming transfers'. */
  readonly title: string;
  /** Short description for the settings screen. */
  readonly description: string;
}

/**
 * A notification "template" (the Laravel-style notification class). Declares which
 * channels it goes through and how it renders on each. New notification types
 * implement this interface and nothing else changes in the engine. Catalog
 * metadata (`type` / `title` / `description`) lives on each class as a static
 * `META` and is mirrored to instance properties for runtime access.
 */
export interface AppNotification extends NotificationMeta {
  /** Channels this notification is delivered through for the given recipient. */
  via(notifiable: Notifiable): NotificationChannelName[];

  /** Idempotency key (per recipient). Two sends with the same key collapse to one. */
  dedupKey(notifiable: Notifiable): string;

  /** Render for Expo. Required because 'expo' is the only v1 channel. */
  toExpo(notifiable: Notifiable): ExpoMessageContent;

  // Future channels add optional renderers; engine + existing notifications stay untouched:
  // toDatabase?(notifiable: Notifiable): Record<string, unknown>;
  // toWebsocket?(notifiable: Notifiable): unknown;
}

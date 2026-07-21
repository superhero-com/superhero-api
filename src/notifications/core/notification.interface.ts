import { Notifiable } from './notifiable.interface';

// The live websocket push is a transport detail of the 'database' channel (it
// re-emits the persisted row), not a channel of its own — there is no separate
// renderer or registry entry for it, so it is intentionally NOT a channel name.
// 'web-push' (browser VAPID push) IS a real channel: it has its own registry
// entry and delivery queue, and renders via toDatabase() (the web copy).
export type NotificationChannelName = 'expo' | 'database' | 'web-push';

export interface ExpoMessageContent {
  title: string;
  body: string;
  /** Deep-link payload handed to the app on tap. */
  data?: Record<string, unknown>;
}

/**
 * Rendered content persisted as one `notifications` row for the web in-app feed
 * (and emitted live over the gateway). Same shape as the push content; kept as a
 * distinct type so the feed copy can diverge from the push copy later without a
 * signature change.
 */
export interface DatabaseNotificationContent {
  title: string;
  body: string;
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

  /** Render for Expo. Required because 'expo' is the only mobile push channel. */
  toExpo(notifiable: Notifiable): ExpoMessageContent;

  /**
   * Render for the persisted web feed. Required whenever `via()` includes
   * `'database'`; the `DatabaseChannel` throws if it is routed a notification
   * that omits this, surfacing a mis-wired type instead of silently dropping it.
   * The live websocket emit reuses the persisted row, so there is no separate
   * `toWebsocket` renderer — the feed row IS the realtime payload.
   */
  toDatabase?(notifiable: Notifiable): DatabaseNotificationContent;
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { NOTIFICATION_CHANNELS } from '../notifications.constants';
import { NotificationPreferencesService } from '../services/notification-preferences.service';
import { Notifiable } from './notifiable.interface';
import {
  AppNotification,
  NotificationChannelName,
} from './notification.interface';
import { NotificationChannel } from './notification-channel.interface';

/**
 * Outcome of a single `send()` call. Callers use this to distinguish between
 * "queued for delivery", "skipped by the user", "no channel available", and
 * "all channels failed", which the previous `Promise<void>` return type erased.
 * Announcements use this to write accurate per-recipient counters; the chain-
 * transfer listener uses it only for structured logging.
 *
 * Distinguishing `no-channel` from `failed` is intentional: a recipient with no
 * registered channel for this notification type is not a delivery failure — it
 * is a "user is unreachable on this notification type" outcome, which should
 * not page operators or accumulate in the failure column.
 */
export type SendOutcome =
  | { outcome: 'sent' }
  | { outcome: 'opted-out' }
  | { outcome: 'no-channel' }
  | { outcome: 'failed'; channel: NotificationChannelName; error: string };

/**
 * The dispatcher. Resolves the channels a notification declares via `via()`
 * and fans out to them. Channels are expected to **throw** on failure (no
 * internal swallow); this dispatcher catches the failure and reports it via
 * `SendOutcome`. Every rejected channel result is logged, not just the first —
 * so a multi-channel notification with a persistent secondary outage produces
 * a per-tick log line instead of a silent backlog.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly channels: Map<NotificationChannelName, NotificationChannel>;

  constructor(
    @Inject(NOTIFICATION_CHANNELS) channels: NotificationChannel[],
    private readonly preferences: NotificationPreferencesService,
  ) {
    this.channels = new Map(channels.map((c) => [c.name, c]));
  }

  async send(
    notifiable: Notifiable,
    notification: AppNotification,
  ): Promise<SendOutcome> {
    // Single chokepoint for per-(address, type) opt-out. Default true.
    if (
      !(await this.preferences.isEnabled(notifiable.address, notification.type))
    ) {
      return { outcome: 'opted-out' };
    }
    const names = notification.via(notifiable);
    if (names.length === 0) {
      return { outcome: 'no-channel' };
    }

    const results = await Promise.allSettled(
      names.map((name) => {
        const channel = this.channels.get(name);
        if (!channel) {
          return Promise.reject(new Error(`unknown channel "${name}"`));
        }
        return channel.send(notifiable, notification);
      }),
    );

    // Log every rejection (not just the first), so multi-channel notifications
    // don't silently lose secondary failures from observability.
    let firstFailureIndex = -1;
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        this.logger.error(
          `Channel "${names[i]}" failed for "${notification.type}"`,
          result.reason as Error,
        );
        if (firstFailureIndex === -1) {
          firstFailureIndex = i;
        }
      }
    });

    if (firstFailureIndex === -1) {
      return { outcome: 'sent' };
    }
    const reason = (results[firstFailureIndex] as PromiseRejectedResult).reason;
    return {
      outcome: 'failed',
      channel: names[firstFailureIndex],
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}

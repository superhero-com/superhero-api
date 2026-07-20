import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bull';
import { Notifiable } from '../core/notifiable.interface';
import { AppNotification } from '../core/notification.interface';
import { NotificationChannel } from '../core/notification-channel.interface';
import { NotificationDedupService } from '../services/notification-dedup.service';
import { WebPushSubscriptionService } from '../services/web-push-subscription.service';
import { WebPushClient, WebPushPayload } from '../web-push/web-push.client';
import {
  SEND_WEB_PUSH_JOB_OPTIONS,
  SEND_WEB_PUSH_QUEUE,
} from '../queues/constants';

/** One Bull job = one encrypted push to one browser subscription. */
export interface SendWebPushJob {
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  payload: WebPushPayload;
  /**
   * The logical dedup key acquired before enqueue. Carried so the processor can
   * release it once retries are exhausted, letting a later re-observation
   * re-deliver instead of being suppressed for the full dedup TTL.
   */
  dedupKey: string;
}

/**
 * Browser Web Push channel (VAPID). Renders the same web-targeted copy the feed
 * uses (`toDatabase()`), then enqueues one send job per registered subscription
 * so the actual HTTP send (and its retries / dead-subscription pruning) happens
 * off the caller's thread — exactly like {@link ExpoChannel}.
 *
 * Complements, not replaces, the websocket stream: the socket updates an open
 * tab live; this delivers a native OS notification even with no tab open. The
 * persisted feed remains the source of truth for anything missed.
 *
 * Dedup is channel-namespaced (`web-push:…`) so it can't collide with the Expo
 * or database channel marker for the same logical notification.
 */
@Injectable()
export class WebPushChannel implements NotificationChannel {
  readonly name = 'web-push' as const;
  private readonly logger = new Logger(WebPushChannel.name);

  constructor(
    private readonly subscriptions: WebPushSubscriptionService,
    private readonly dedup: NotificationDedupService,
    private readonly client: WebPushClient,
    @InjectQueue(SEND_WEB_PUSH_QUEUE)
    private readonly queue: Queue<SendWebPushJob>,
  ) {}

  async send(
    notifiable: Notifiable,
    notification: AppNotification,
  ): Promise<void> {
    // Feature stays dark until a VAPID keypair is configured.
    if (!this.client.isConfigured()) {
      return;
    }

    if (!notification.toDatabase) {
      // via() promised 'web-push' but the type can't render web copy — a wiring
      // bug. Throw so the dispatcher logs it instead of silently dropping.
      throw new Error(
        `Notification "${notification.type}" routes to 'web-push' but has no toDatabase()`,
      );
    }

    const subs = await this.subscriptions.getActiveForAddress(
      notifiable.address,
    );
    if (subs.length === 0) {
      return;
    }

    const content = notification.toDatabase(notifiable);
    const payload: WebPushPayload = {
      title: content.title,
      body: content.body,
      data: content.data,
    };

    // Dedup is per (notification, SUBSCRIPTION) — not one key for the whole
    // fan-out. With a shared key, a single dead endpoint that exhausts its
    // retries would release the marker for ALL of this address's devices, and a
    // later re-observation would re-push to the healthy ones too (duplicate
    // notification on every other device). Per-endpoint keys keep each device's
    // idempotency — and its release — independent.
    const logicalKey = notification.dedupKey(notifiable);
    for (const sub of subs) {
      const dedupKey = `${this.name}:${notification.type}:${logicalKey}:${sub.endpoint}`;
      // eslint-disable-next-line no-await-in-loop
      const acquired = await this.dedup.tryAcquire(dedupKey);
      if (!acquired) {
        continue; // this device already got (or is getting) this notification
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.queue.add(
          {
            subscription: {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload,
            dedupKey,
          },
          SEND_WEB_PUSH_JOB_OPTIONS,
        );
      } catch (error) {
        // The job never made it onto the queue (Redis/Bull blip), so nothing
        // will ever release this marker via the processor's own retry-exhausted
        // path. Release it here instead — otherwise a one-shot notification
        // (invitation-claimed, post-comment, …) would be silently suppressed
        // for this device until the dedup TTL expires, with no retry ever
        // having been attempted. Release-then-continue (not rethrow): one
        // subscription's enqueue failure must not stop delivery to the rest of
        // this address's devices.
        // eslint-disable-next-line no-await-in-loop
        await this.dedup.release(dedupKey).catch((releaseError) => {
          this.logger.warn(
            `Failed to release dedup key "${dedupKey}" after a failed enqueue: ${
              (releaseError as Error).message
            }`,
          );
        });
        this.logger.warn(
          `Failed to enqueue web-push for ${sub.endpoint}: ${
            (error as Error).message
          }`,
        );
      }
    }
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import webpush, { PushSubscription, WebPushError } from 'web-push';
import notificationsConfig from '../notifications.config';

/** Encrypted payload delivered to the service worker (mirrors the feed copy). */
export interface WebPushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * How the queue processor should react to a failed send:
 * - `expired`   → the subscription is gone (404/410); delete it, no retry.
 * - `retryable` → transient (429/5xx/timeout/network); rethrow for Bull backoff.
 * - `permanent` → our fault (400/403/413 — bad payload or VAPID mismatch); log
 *   and drop, retrying won't help and the subscription may still be valid.
 */
export type WebPushFailure = 'expired' | 'retryable' | 'permanent';

/**
 * Default push TTL (seconds): how long the push service should hold the message
 * for an offline browser before discarding it. The feed is the source of truth
 * for anything missed, so a day is plenty and avoids stale buildup.
 */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

/**
 * Thin wrapper over the `web-push` library, mirroring `ExpoPushClient`. Sets the
 * VAPID identity once at construction and exposes a single bounded `send`. When
 * VAPID keys are not configured it reports `isConfigured() === false` so the
 * channel can no-op instead of throwing on every notification.
 */
@Injectable()
export class WebPushClient {
  private readonly logger = new Logger(WebPushClient.name);
  private readonly configured: boolean;
  private readonly timeoutMs: number;

  constructor(
    @Inject(notificationsConfig.KEY)
    config: ConfigType<typeof notificationsConfig>,
  ) {
    this.timeoutMs = config.webPushFetchTimeoutMs;
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      try {
        webpush.setVapidDetails(
          config.vapidSubject,
          config.vapidPublicKey,
          config.vapidPrivateKey,
        );
        this.configured = true;
      } catch (error) {
        // Malformed key/subject: disable the channel rather than crash boot. Ops
        // see the warning and fix the env; everything else keeps working.
        this.configured = false;
        this.logger.error(
          `Invalid VAPID configuration; web-push channel is disabled: ${
            (error as Error).message
          }`,
        );
      }
    } else {
      this.configured = false;
      this.logger.warn(
        'VAPID keys not configured (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY); web-push channel is disabled',
      );
    }
  }

  /** True once a VAPID keypair is configured; the channel gates on this. */
  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Send one encrypted push. Throws on failure (the processor classifies the
   * error via {@link WebPushClient.classify}); resolves on a 2xx accept.
   */
  async send(
    subscription: PushSubscription,
    payload: WebPushPayload,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    // `timeout` is web-push's NATIVE socket timeout (passed straight to the
    // underlying `https.request`): on expiry the library itself calls
    // `request.destroy(...)`, genuinely killing the in-flight HTTP call before
    // rejecting — the same guarantee ExpoPushClient gets from AbortController.
    // We previously raced sendNotification() against our own setTimeout via
    // Promise.race, which only stops OUR side from waiting; the original
    // request kept running in the background, and a push service that was
    // merely slow (not actually down) could still deliver it AFTER we'd
    // already classified the send as failed and let Bull re-enqueue a retry —
    // duplicating the OS notification on the user's device.
    await webpush.sendNotification(subscription, body, {
      TTL: PUSH_TTL_SECONDS,
      timeout: this.timeoutMs,
    });
  }

  /** Map a thrown send error to a handling strategy. */
  static classify(error: unknown): WebPushFailure {
    const status = error instanceof WebPushError ? error.statusCode : undefined;
    if (status === 404 || status === 410) {
      return 'expired';
    }
    if (status === undefined || status === 429 || status >= 500) {
      // No status = timeout / network error → transient.
      return 'retryable';
    }
    return 'permanent';
  }
}

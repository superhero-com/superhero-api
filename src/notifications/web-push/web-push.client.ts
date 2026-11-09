import { createECDH } from 'crypto';
import https from 'https';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import webpush, {
  Headers,
  PushSubscription,
  RequestDetails,
  WebPushError,
} from 'web-push';
import notificationsConfig from '../notifications.config';
import { parsePushEndpoint } from './push-endpoint';

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
 * - `permanent` → our fault (400/403/413 — bad payload or VAPID mismatch) or a
 *   stored subscription we can't send to (host off the allowlist, keys web-push
 *   can't encrypt to); log and drop, retrying won't help.
 */
export type WebPushFailure = 'expired' | 'retryable' | 'permanent';

/**
 * Default push TTL (seconds): how long the push service should hold the message
 * for an offline browser before discarding it. The feed is the source of truth
 * for anything missed, so a day is plenty and avoids stale buildup.
 */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

/** Push services reply with an empty or short body; nothing past this is read. */
export const MAX_PUSH_RESPONSE_BYTES = 64 * 1024;

/** Nothing was sent, and no attempt with this subscription ever can be. */
export class UnsendablePushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsendablePushError';
  }
}

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
  private readonly allowedHosts: readonly string[];

  constructor(
    @Inject(notificationsConfig.KEY)
    config: ConfigType<typeof notificationsConfig>,
  ) {
    this.timeoutMs = config.webPushFetchTimeoutMs;
    this.allowedHosts = config.webPushAllowedHosts;
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      try {
        webpush.setVapidDetails(
          config.vapidSubject,
          config.vapidPublicKey,
          config.vapidPrivateKey,
        );
        // setVapidDetails only checks each key's FORMAT. A public key that does
        // not belong to the private key passes it, the frontend then subscribes
        // browsers with that public key, and every send fails as a permanent
        // 403 that the queue drops silently. Refuse the pair at boot instead.
        if (!vapidKeysMatch(config.vapidPublicKey, config.vapidPrivateKey)) {
          throw new Error(
            'VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY (regenerate them as one pair)',
          );
        }
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
      const message =
        'VAPID keys not configured (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY); web-push channel is disabled';
      // In production a missing pair means browser push is silently off for
      // every user (GET /notifications/web-push/vapid-public-key answers null),
      // so say it at error level where it gets noticed.
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(message);
      } else {
        this.logger.warn(message);
      }
    }
  }

  /** True once a VAPID keypair is configured; the channel gates on this. */
  isConfigured(): boolean {
    return this.configured;
  }

  /** Whether `send` would contact this endpoint at all. */
  acceptsEndpoint(endpoint: string): boolean {
    return parsePushEndpoint(endpoint, this.allowedHosts) !== null;
  }

  /**
   * Send one encrypted push. Throws on failure (the processor classifies the
   * error via {@link WebPushClient.classify}); resolves on a 2xx accept.
   */
  async send(
    subscription: PushSubscription,
    payload: WebPushPayload,
  ): Promise<void> {
    const url = parsePushEndpoint(subscription.endpoint, this.allowedHosts);
    if (!url) {
      throw new UnsendablePushError(
        'endpoint is not on an allowed push-service host',
      );
    }
    let details: RequestDetails;
    try {
      details = webpush.generateRequestDetails(
        subscription,
        JSON.stringify(payload),
        { TTL: PUSH_TTL_SECONDS },
      );
    } catch (error) {
      // Keys that pass the DTO's length check can still be off the curve, and
      // they fail identically on every retry.
      throw new UnsendablePushError(
        `cannot encrypt to this subscription: ${(error as Error).message}`,
      );
    }
    await this.post(url, details);
  }

  // web-push's sendNotification buffers the whole reply into one string (a huge
  // reply kills the process) and only has an idle timeout, hence this. A timeout
  // destroys the request, so nothing keeps connecting or reading after we give up.
  private post(url: URL, details: RequestDetails): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      };

      const request = https.request(
        url,
        { method: details.method, headers: details.headers },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const finish = (): void => {
            const status = response.statusCode ?? 0;
            if (status >= 200 && status <= 299) {
              settle();
              return;
            }
            settle(
              new WebPushError(
                'Received unexpected response code',
                status,
                response.headers as Headers,
                Buffer.concat(chunks).toString(),
                details.endpoint,
              ),
            );
          };
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            const room = MAX_PUSH_RESPONSE_BYTES - size;
            if (chunk.length <= room) {
              chunks.push(chunk);
              size += chunk.length;
              return;
            }
            // Only the status matters, so settle on it and stop downloading.
            chunks.push(chunk.subarray(0, room));
            finish();
            request.destroy();
          });
          response.on('end', finish);
          response.on('error', settle);
        },
      );

      // Armed only once the request exists; settle() always runs later than this.
      const deadline = setTimeout(() => {
        request.destroy(
          new Error(`Web push send timed out after ${this.timeoutMs}ms`),
        );
      }, this.timeoutMs);
      request.on('error', settle);
      if (details.body) {
        request.write(details.body);
      }
      request.end();
    });
  }

  /** Map a thrown send error to a handling strategy. */
  static classify(error: unknown): WebPushFailure {
    if (error instanceof UnsendablePushError) {
      return 'permanent';
    }
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

/**
 * True when `publicKey` (base64url, uncompressed P-256 point) is the public half
 * of `privateKey` (base64url, 32-byte scalar). Any decode error counts as false.
 */
export function vapidKeysMatch(publicKey: string, privateKey: string): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    return ecdh.getPublicKey().equals(Buffer.from(publicKey, 'base64url'));
  } catch {
    return false;
  }
}

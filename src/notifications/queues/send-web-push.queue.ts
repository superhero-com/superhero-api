import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { NotificationDedupService } from '../services/notification-dedup.service';
import { WebPushSubscriptionService } from '../services/web-push-subscription.service';
import { WebPushClient } from '../web-push/web-push.client';
import { SendWebPushJob } from '../channels/web-push.channel';
import { SEND_WEB_PUSH_QUEUE } from './constants';

/**
 * Sends ONE encrypted push per Bull job. The producer (WebPushChannel) enqueues
 * one job per subscription, so a retry re-sends only to that one endpoint.
 *
 * Failure handling mirrors the Expo processor:
 * - `expired` (404/410) → the subscription is gone; delete it and complete the
 *   job (no retry, the dedup marker stays so we don't re-deliver).
 * - `permanent` (400/403/413) → our payload/VAPID is wrong; log and drop.
 * - `retryable` (429/5xx/timeout) → rethrow for Bull backoff; on the final
 *   attempt release the dedup marker so a later re-observation can re-deliver.
 */
@Processor(SEND_WEB_PUSH_QUEUE)
export class SendWebPushQueue {
  private readonly logger = new Logger(SendWebPushQueue.name);

  constructor(
    private readonly client: WebPushClient,
    private readonly subscriptions: WebPushSubscriptionService,
    private readonly dedup: NotificationDedupService,
  ) {}

  @Process({ concurrency: 5 })
  async process(job: Job<SendWebPushJob>): Promise<void> {
    try {
      await this.deliver(job.data);
    } catch (error) {
      // Only retryable failures reach here (deliver() swallows expired/permanent).
      // On the LAST attempt, drop the dedup marker so a later re-observation can
      // re-deliver instead of being suppressed for the full dedup TTL.
      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;
      if (isFinalAttempt && job.data.dedupKey) {
        await this.dedup
          .release(job.data.dedupKey)
          .catch((releaseError) =>
            this.logger.warn(
              `Failed to release dedup key "${job.data.dedupKey}" after exhausted retries: ${
                (releaseError as Error).message
              }`,
            ),
          );
      }
      throw error;
    }
  }

  private async deliver(data: SendWebPushJob): Promise<void> {
    try {
      await this.client.send(data.subscription, data.payload);
    } catch (error) {
      const failure = WebPushClient.classify(error);
      const status = (error as { statusCode?: number }).statusCode;
      if (failure === 'expired') {
        await this.subscriptions.prune(data.subscription.endpoint);
        return;
      }
      if (failure === 'permanent') {
        // Unlike `expired` (routine unsubscribe churn — no operator action
        // needed) or `retryable` (Bull's own backoff/exhaustion is the
        // signal), `permanent` means OUR payload or VAPID config is wrong —
        // e.g. a rotated VAPID key mismatching a still-stored subscription.
        // That is static, not transient: every future send will keep failing
        // the exact same way until an operator fixes it, so this MUST be
        // visible. `main.ts` keeps only `error`-level logs when DEBUG_ENABLED
        // is off, so a `warn` here would be silently dropped in production;
        // use `error` so the broken channel actually surfaces an operator signal.
        this.logger.error(
          `Permanent web-push failure for ${data.subscription.endpoint} ` +
            `(status=${status ?? 'n/a'}): ${(error as Error).message} — ` +
            'dropping (not retrying); check VAPID config / payload shape.',
        );
        return;
      }
      throw error;
    }
  }
}

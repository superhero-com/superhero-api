import type { JobOptions } from 'bull';
import {
  cappedExponentialBackoff,
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_BACKOFF_CAP_MS,
} from './publish-policy';

/** Custom Bull backoff-strategy name registered on the `publish-nip29` queue. */
export const TGR_CAPPED_BACKOFF = 'tgr-capped';

/**
 * Bull custom backoff strategy: capped exponential clamped to 5m (§18). Registered
 * via the queue's `settings.backoffStrategies` so enqueued jobs can reference it
 * by name. Bull passes the 1-based `attemptsMade`.
 */
export function cappedBackoffStrategy(attemptsMade: number): number {
  return cappedExponentialBackoff(
    attemptsMade,
    PUBLISH_BACKOFF_BASE_MS,
    PUBLISH_BACKOFF_CAP_MS,
  );
}

/**
 * Recommended `JobOptions` for enqueuing onto `worker:publish-nip29`
 * (Tasks 08/09/10 spread this when they `queue.add(...)`). Encodes the §18
 * retry/backoff contract: `attempts = maxRetries + 1`, capped-exponential backoff.
 *
 * `maxRetries` should come from `tgrConfig.publishMaxRetries`.
 */
export function publishNip29JobOptions(maxRetries: number): JobOptions {
  return {
    attempts: Math.max(1, maxRetries + 1),
    backoff: { type: TGR_CAPPED_BACKOFF },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

import { JobOptions } from 'bull';

export const SEND_EXPO_NOTIFICATION_QUEUE = 'send-expo-notification';
export const EXPO_RECEIPT_QUEUE = 'expo-receipt';
export const SEND_WEB_PUSH_QUEUE = 'send-web-push';

/**
 * Retry + cleanup policy for an Expo push-send job (one Expo-sized chunk). A
 * retry re-sends only this chunk; `removeOnFail: 100` keeps the last 100 failed
 * jobs for inspection without unbounded growth.
 */
export const SEND_EXPO_JOB_OPTIONS: JobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
};

/**
 * Retry + cleanup policy for a delivery-receipt poll job. The initial `delay`
 * (config.receiptDelayMs — Expo recommends ~15 min) is layered on at the
 * enqueue site since it is config-driven.
 */
export const EXPO_RECEIPT_JOB_OPTIONS: JobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: 100,
};

/**
 * Retry + cleanup policy for a single Web Push send job (one subscription). A
 * retry re-sends only to that one subscription. Dead subscriptions (404/410) are
 * pruned without a retry; only transient failures (429/5xx/timeout) re-throw and
 * back off.
 */
export const SEND_WEB_PUSH_JOB_OPTIONS: JobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: 100,
};

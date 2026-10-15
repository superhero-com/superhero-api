import { AsyncLocalStorage } from 'node:async_hooks';
import { ShortsJobAttempt } from './shorts-job-attempt';

export const SHORTS_PUBLISHER_ATTEMPT_MS = Symbol(
  'SHORTS_PUBLISHER_ATTEMPT_MS',
);
const context = new AsyncLocalStorage<PublisherAttempt>();

/** The SDK's implicit node calls inherit the attempt, including late continuations. */
export class PublisherAttempt extends ShortsJobAttempt {
  constructor(shutdown: AbortSignal, timeoutMs = 120000) {
    if (timeoutMs > 120000)
      throw new Error('Invalid publisher attempt deadline');
    super(shutdown, timeoutMs);
  }
  run<T>(work: () => Promise<T>) {
    return context.run(this, work);
  }
}

export function currentPublisherAttempt() {
  const attempt = context.getStore();
  attempt?.check();
  return attempt;
}

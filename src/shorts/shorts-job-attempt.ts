import { performance } from 'node:perf_hooks';

/** Local cancellation supplements, but never replaces, database lease fencing. */
export class ShortsJobAttempt {
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private leaseUntil = Infinity;
  private readonly timer: NodeJS.Timeout;
  private leaseTimer?: NodeJS.Timeout;
  readonly signal = this.controller.signal;
  readonly abort = () => this.controller.abort();

  constructor(
    private readonly shutdown: AbortSignal,
    timeoutMs: number,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000)
      throw new Error('Invalid Shorts job deadline');
    this.deadline = performance.now() + timeoutMs;
    this.timer = setTimeout(this.abort, timeoutMs);
    this.timer.unref();
    shutdown.addEventListener('abort', this.abort, { once: true });
    if (shutdown.aborted) this.abort();
  }
  check() {
    if (performance.now() >= Math.min(this.deadline, this.leaseUntil))
      this.abort();
    this.signal.throwIfAborted();
  }
  lease(startedAt: number, leaseMs: number) {
    this.check();
    this.leaseUntil = startedAt + leaseMs;
    this.check();
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(
      this.abort,
      this.leaseUntil - performance.now(),
    );
    this.leaseTimer.unref();
  }
  close() {
    this.abort();
    clearTimeout(this.timer);
    clearTimeout(this.leaseTimer);
    this.shutdown.removeEventListener('abort', this.abort);
  }
}

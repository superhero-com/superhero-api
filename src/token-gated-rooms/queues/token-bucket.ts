/**
 * A simple async token-bucket rate limiter (Task 07 §4).
 *
 * One shared bucket per worker caps the publish rate to `ratePerSec` events/sec
 * across all `TG_PUBLISH_CONCURRENCY` workers — a second line of defence alongside
 * Bull's queue `limiter`. `take()` resolves immediately when a token is
 * available and otherwise waits exactly long enough for the bucket to refill,
 * so a burst of N callers is smoothed to ≤ `ratePerSec` per rolling second.
 *
 * Pure of NestJS so it is directly unit-testable; `now`/`sleep` are injectable
 * for deterministic tests (fake clock).
 */
export interface TokenBucketDeps {
  /** Monotonic-ish clock in ms (default `Date.now`). */
  now?: () => number;
  /** Sleep helper (default `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private last: number;
  /** Serializes waiters so the refill window is honoured FIFO under burst. */
  private chain: Promise<void> = Promise.resolve();

  constructor(ratePerSec: number, deps: TokenBucketDeps = {}) {
    this.capacity = Math.max(1, ratePerSec);
    this.refillPerMs = this.capacity / 1000;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.last;
    if (elapsed <= 0) {
      return;
    }
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsed * this.refillPerMs,
    );
    this.last = t;
  }

  /** Acquire one token, waiting (FIFO) until one is available. */
  async take(): Promise<void> {
    // Chain so concurrent callers don't all observe the same refill snapshot
    // and over-spend; each waits for the previous to settle its reservation.
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      await this.reserve();
    } finally {
      release();
    }
  }

  private async reserve(): Promise<void> {
    // Loop: refill, spend if possible, else sleep the deficit and retry.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil(deficit / this.refillPerMs);
      await this.sleep(Math.max(1, waitMs));
    }
  }
}

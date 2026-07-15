import { TokenBucket } from '../token-bucket';

/**
 * A controllable fake clock: `now()` is read from `t`; `sleep(ms)` advances `t`
 * and resolves on a microtask, so the bucket's wait loop is deterministic and
 * fast (no real timers).
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('paces steady-state to ratePerSec per second after the initial burst', async () => {
    const clock = fakeClock();
    const rate = 10;
    const bucket = new TokenBucket(rate, {
      now: clock.now,
      sleep: clock.sleep,
    });

    const grantTimes: number[] = [];
    // Burst of 30 takes against a rate of 10/s with a full initial bucket.
    for (let i = 0; i < 30; i++) {
      await bucket.take();
      grantTimes.push(clock.now());
    }

    // After the one-time initial burst of `capacity` grants (which land at t=0),
    // every `rate` consecutive grants must span at least ~1000ms — i.e. the
    // sustained throughput never exceeds `ratePerSec`.
    for (let i = rate; i + rate < grantTimes.length; i++) {
      const windowSpan = grantTimes[i + rate] - grantTimes[i];
      expect(windowSpan).toBeGreaterThanOrEqual(1000 - 1);
    }
  });

  it('bounds the initial burst to capacity (= ratePerSec) at t=0', async () => {
    const clock = fakeClock();
    const rate = 8;
    const bucket = new TokenBucket(rate, {
      now: clock.now,
      sleep: clock.sleep,
    });

    let freeGrants = 0;
    for (let i = 0; i < 20; i++) {
      await bucket.take();
      if (clock.now() === 0) {
        freeGrants += 1;
      }
    }
    expect(freeGrants).toBe(rate);
  });

  it('drains the initial capacity immediately then paces', async () => {
    const clock = fakeClock();
    const rate = 5;
    const bucket = new TokenBucket(rate, {
      now: clock.now,
      sleep: clock.sleep,
    });

    // First `rate` takes are free (full bucket) — clock should not advance.
    for (let i = 0; i < rate; i++) {
      await bucket.take();
    }
    expect(clock.now()).toBe(0);

    // The next take must wait for a refill (clock advances).
    await bucket.take();
    expect(clock.now()).toBeGreaterThan(0);
  });

  it('refills over time so a later take is free again', async () => {
    const clock = fakeClock();
    const rate = 4;
    const bucket = new TokenBucket(rate, {
      now: clock.now,
      sleep: clock.sleep,
    });

    for (let i = 0; i < rate; i++) {
      await bucket.take();
    }
    // Let a full second pass — bucket refills to capacity.
    clock.advance(1000);
    const before = clock.now();
    await bucket.take();
    // No additional wait needed (token was available after refill).
    expect(clock.now()).toBe(before);
  });

  it('treats rate < 1 as a capacity of at least 1', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(0, { now: clock.now, sleep: clock.sleep });
    await expect(bucket.take()).resolves.toBeUndefined();
  });
});

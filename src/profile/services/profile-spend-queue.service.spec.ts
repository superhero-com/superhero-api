import { encode, Encoding } from '@aeternity/aepp-sdk';
import { ProfileSpendQueueService } from './profile-spend-queue.service';

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('ProfileSpendQueueService', () => {
  // A 32-byte seed expressed two different ways: raw hex and the sk_-encoded
  // secret key. Both denote the SAME on-chain account and MUST share one queue.
  const seedHex = 'ab'.repeat(32);
  const skForm = encode(
    Uint8Array.from(Buffer.from(seedHex, 'hex')),
    Encoding.AccountSecretKey,
  );

  it('serializes spends for the same wallet across different key encodings', async () => {
    const service = new ProfileSpendQueueService();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = service.enqueueSpend(seedHex, async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    const second = service.enqueueSpend(skForm, async () => {
      order.push('second-start');
    });

    await flushMicrotasks();
    // The second spend (same wallet, different encoding) must wait.
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('runs spends for different wallets concurrently', async () => {
    const service = new ProfileSpendQueueService();
    const otherSeedHex = 'cd'.repeat(32);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = service.enqueueSpend(seedHex, async () => {
      order.push('a-start');
      await firstGate;
      order.push('a-end');
    });
    const second = service.enqueueSpend(otherSeedHex, async () => {
      order.push('b-start');
    });

    await flushMicrotasks();
    // Different wallets → b is not blocked by a still-running a.
    expect(order).toContain('b-start');
    expect(order).not.toContain('a-end');

    releaseFirst();
    await Promise.all([first, second]);
  });

  it('keeps serializing the queue even when a spend rejects', async () => {
    const service = new ProfileSpendQueueService();
    const order: string[] = [];

    const first = service
      .enqueueSpend(seedHex, async () => {
        order.push('first');
        throw new Error('boom');
      })
      .catch(() => order.push('first-rejected'));
    const second = service.enqueueSpend(seedHex, async () => {
      order.push('second');
    });

    await Promise.all([first, second]);
    // Second still ran after the first rejected (queue not wedged).
    expect(order).toContain('second');
    expect(order.indexOf('first')).toBeLessThan(order.indexOf('second'));
  });
});

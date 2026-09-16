import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { DATABASE_CONFIG } from '@/configs/database';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { ProfileSpendQueueService } from './profile-spend-queue.service';

/**
 * Live proof that the reward-payout guard is CROSS-PROCESS, not just
 * process-local: two `ProfileSpendQueueService` instances backed by SEPARATE
 * DataSources (two connection pools = two "pods") to the SAME database still
 * serialize spends for one reward wallet through the Postgres advisory lock, and
 * a spend that throws still releases the lock. A mock asserting SQL text could
 * not prove either; this needs a real Postgres (`DB_HOST`).
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

// A valid 32-byte seed → both services derive the same `ak_` lock key from it.
const REWARD_KEY = '11'.repeat(32);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await delay(10);
  }
};

d('ProfileSpendQueueService payout advisory lock (cross-process)', () => {
  let db: IsolatedDb;
  let secondDataSource: DataSource;
  let serviceA: ProfileSpendQueueService;
  let serviceB: ProfileSpendQueueService;

  beforeAll(async () => {
    // Empty throwaway database: the advisory lock is keyed by an int + hashtext,
    // so no tables are needed.
    db = await createIsolatedDatabase({ entities: [], migrations: [] });
    secondDataSource = new DataSource({
      ...(DATABASE_CONFIG as DataSourceOptions),
      database: db.name,
      synchronize: false,
      entities: [],
      migrations: [],
      logging: false,
    } as DataSourceOptions);
    await secondDataSource.initialize();
    serviceA = new ProfileSpendQueueService(db.dataSource);
    serviceB = new ProfileSpendQueueService(secondDataSource);
  }, 60_000);

  afterAll(async () => {
    if (secondDataSource?.isInitialized) {
      await secondDataSource.destroy().catch(() => undefined);
    }
    await db?.drop();
  });

  it('makes a second pod wait until the first releases the wallet lock', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serviceA.enqueueSpend(REWARD_KEY, async () => {
      order.push('a-start');
      await firstGate;
      order.push('a-end');
    });
    // Wait until pod A actually holds the lock before pod B tries.
    await waitUntil(() => order.includes('a-start'));

    const second = serviceB.enqueueSpend(REWARD_KEY, async () => {
      order.push('b-start');
    });
    // Pod B must block on the advisory lock while A still holds it.
    await delay(300);
    expect(order).toEqual(['a-start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  }, 20_000);

  it('releases the lock even when the spend throws, so the next pod proceeds', async () => {
    await expect(
      serviceA.enqueueSpend(REWARD_KEY, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The other pod can still acquire the same wallet lock afterwards.
    let ran = false;
    await serviceB.enqueueSpend(REWARD_KEY, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  }, 20_000);
});

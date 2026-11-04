import 'dotenv/config';
import { Repository } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { NotificationRecord } from '../entities/notification.entity';
import { WebPushSubscription } from '../entities/web-push-subscription.entity';
import {
  MAX_WEB_PUSH_SUBSCRIPTIONS_PER_ADDRESS as MAX,
  WebPushSubscriptionService,
} from './web-push-subscription.service';

const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('WebPushSubscriptionService per-address cap (integration)', () => {
  let db: IsolatedDb;
  let repo: Repository<WebPushSubscription>;
  let service: WebPushSubscriptionService;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [NotificationRecord, WebPushSubscription],
      migrations: [
        __dirname + '/../../migrations/1718900000020-WebNotificationFeed.ts',
      ],
    });
    await db.dataSource.runMigrations();
    repo = db.dataSource.getRepository(WebPushSubscription);
    service = new WebPushSubscriptionService(repo);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await repo.clear();
  });

  const sub = (n: number) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
    p256dh: 'p',
    auth: 'a',
  });
  const endpointsOf = async (address: string) =>
    (await repo.find({ where: { address } })).map((row) => row.endpoint);

  it('evicts the least recently seen rows beyond the cap', async () => {
    for (let n = 1; n <= MAX + 2; n++) {
      await service.upsert('ak_a', sub(n));
    }

    const kept = await endpointsOf('ak_a');
    expect(kept).toHaveLength(MAX);
    expect(kept).not.toContain(sub(1).endpoint);
    expect(kept).not.toContain(sub(2).endpoint);
    expect(kept).toContain(sub(MAX + 2).endpoint);
  });

  it('keeps a re-posted browser, since the re-post makes it the most recent', async () => {
    for (let n = 1; n <= MAX; n++) {
      await service.upsert('ak_a', sub(n));
    }
    await service.upsert('ak_a', sub(1));
    await service.upsert('ak_a', sub(MAX + 1));

    const kept = await endpointsOf('ak_a');
    expect(kept).toHaveLength(MAX);
    expect(kept).toContain(sub(1).endpoint);
    expect(kept).not.toContain(sub(2).endpoint);
  });

  it("never trims another address's rows", async () => {
    await service.upsert('ak_b', sub(1000));
    for (let n = 1; n <= MAX + 1; n++) {
      await service.upsert('ak_a', sub(n));
    }

    expect(await endpointsOf('ak_b')).toEqual([sub(1000).endpoint]);
  });
});

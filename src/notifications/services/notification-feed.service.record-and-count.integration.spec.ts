import 'dotenv/config';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationFeedService } from './notification-feed.service';

/**
 * DB integration for `NotificationFeedService.recordAndCountUnread()` against a
 * real Postgres.
 *
 * Why this exists: `recordAndCountUnread` fuses an INSERT and an unread-count
 * SELECT into one `WITH ins AS (INSERT … RETURNING …) SELECT … FROM ins`
 * statement. Postgres runs every part of a `WITH` — including the main
 * query — against ONE shared snapshot, and a data-modifying CTE's effects on
 * its target table are visible to the rest of the query ONLY via its
 * `RETURNING` list, not by re-querying the table. A count subquery that
 * re-queries `notifications` directly therefore can NOT see the row `ins` just
 * inserted, and would silently undercount by exactly one. The unit spec for
 * this method only asserts against a *stubbed* `manager.query` — it can return
 * whatever fixture count the test hardcodes, so it can never catch this: it is
 * blind to whether the SQL actually produces the right number against real
 * Postgres snapshot semantics. This spec seeds real pre-existing rows and
 * asserts the count the method actually returns.
 *
 * Isolation: uses a throwaway **database** (not a schema) for the same reason
 * as the sibling `prune` integration spec — this is raw, unqualified SQL, and
 * only a private `public` schema (i.e. its own database) makes that safe.
 * Skipped automatically when no DB host is configured.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('NotificationFeedService.recordAndCountUnread (integration)', () => {
  let db: IsolatedDb;
  let service: NotificationFeedService;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [NotificationRecord],
      migrations: [
        __dirname + '/../../migrations/1718900000020-WebNotificationFeed.ts',
      ],
    });
    await db.dataSource.runMigrations();
    const repo = db.dataSource.getRepository(NotificationRecord);
    service = new NotificationFeedService(repo);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  afterEach(async () => {
    await db.dataSource.query('DELETE FROM notifications');
  });

  async function seed(row: { address: string; read: boolean }): Promise<void> {
    await db.dataSource.query(
      `INSERT INTO notifications (address, type, title, body, read_at)
       VALUES ($1, 'post-comment', 't', 'b', $2)`,
      [row.address, row.read ? new Date() : null],
    );
  }

  it('counts the just-inserted row PLUS every already-unread row for that address', async () => {
    // Two pre-existing unread rows, one read row (must not be counted), and one
    // row for a DIFFERENT address (must not be counted). If the just-inserted
    // row weren't counted, this would wrongly report 2 instead of 3.
    await seed({ address: 'ak_owner', read: false });
    await seed({ address: 'ak_owner', read: false });
    await seed({ address: 'ak_owner', read: true });
    await seed({ address: 'ak_other', read: false });

    const { unreadCount } = await service.recordAndCountUnread(
      'ak_owner',
      'post-comment',
      { title: 't', body: 'b' },
    );

    expect(unreadCount).toBe(3);
  });

  it('returns unreadCount=1 for the very first notification an address ever receives', async () => {
    const { unreadCount, record } = await service.recordAndCountUnread(
      'ak_fresh',
      'post-comment',
      { title: 't', body: 'b' },
    );

    expect(unreadCount).toBe(1);
    expect(record.read_at).toBeNull();
  });
});

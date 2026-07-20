import 'dotenv/config';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { NotificationRecord } from '../entities/notification.entity';
import { NotificationFeedService } from './notification-feed.service';

/**
 * DB integration for `NotificationFeedService.prune()` against a real Postgres.
 *
 * Why this exists: the unit spec for `prune()` only asserts against a *stubbed*
 * query builder — it regexes the raw SQL string (`HAVING count(*) > $1`,
 * `row_number() OVER`, `ranked.rn > $1`) but never actually executes it. A
 * regression that flips the window function's `ORDER BY id DESC` to `ASC` (which
 * would delete the NEWEST rows and keep the oldest — a plausible one-character
 * mistake) makes that unit spec pass unchanged, because it never runs the DELETE.
 * This spec seeds real rows and asserts on the actual survivors.
 *
 * Isolation: `prune()`'s per-address-cap step is raw, UNQUALIFIED SQL
 * (`DELETE FROM notifications …`) — it relies on the connection's default
 * `search_path`, not on TypeORM's `schema` DataSourceOption. A dedicated
 * *schema* on the shared dev database is therefore NOT a safe sandbox for it:
 * the shared DB already has a real `public.notifications` table, and raw SQL
 * against a schema-scoped DataSource still targets `search_path` (`public`) by
 * default, not the isolated schema. (Exactly the hazard the harness README
 * already documents for the TGR migrations, which have the same unqualified-SQL
 * shape.) So this spec uses a throwaway **database** instead — its own private
 * `public` schema makes every unqualified table reference unambiguous — and
 * applies the real migration to create the table, which also re-validates the
 * migration itself. Skipped automatically when no DB host is configured.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('NotificationFeedService.prune (integration)', () => {
  let db: IsolatedDb;
  let service: NotificationFeedService;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [NotificationRecord],
      // Only the migration this spec needs — the TGR migrations require a
      // pre-existing `token` table this spec has no reason to seed.
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

  /** Insert a row with an explicit created_at, bypassing the column default. */
  async function seed(row: {
    address: string;
    read: boolean;
    createdAt: Date;
  }): Promise<number> {
    const result = await db.dataSource.query(
      `INSERT INTO notifications (address, type, title, body, read_at, created_at)
       VALUES ($1, 'post-comment', 't', 'b', $2, $3)
       RETURNING id`,
      [row.address, row.read ? row.createdAt : null, row.createdAt],
    );
    return result[0].id;
  }

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const idsFor = async (address: string): Promise<number[]> => {
    const rows = await db.dataSource.query(
      'SELECT id FROM notifications WHERE address = $1 ORDER BY id',
      [address],
    );
    return rows.map((r: { id: number }) => r.id);
  };

  it('retention cutoff: deletes READ rows older than the horizon, leaves newer read rows and ALL unread rows', async () => {
    const oldRead = await seed({
      address: 'ak_a',
      read: true,
      createdAt: daysAgo(100),
    });
    const recentRead = await seed({
      address: 'ak_a',
      read: true,
      createdAt: daysAgo(1),
    });
    const oldUnread = await seed({
      address: 'ak_a',
      read: false,
      createdAt: daysAgo(100),
    });

    await db.dataSource.transaction((manager) =>
      service.prune(
        manager,
        /* retentionDays */ 90,
        /* maxRowsPerAddress */ 500,
        /* retentionDeleteBatchSize */ 10_000,
      ),
    );

    const survivors = await idsFor('ak_a');
    expect(survivors).not.toContain(oldRead); // aged + read -> pruned
    expect(survivors).toContain(recentRead); // read but within horizon -> kept
    expect(survivors).toContain(oldUnread); // unread is NEVER age-pruned
  });

  it('per-address cap: keeps exactly the newest N rows for an over-cap address, regardless of read state', async () => {
    const cap = 5;
    const ids: number[] = [];
    for (let i = 0; i < cap + 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(
        await seed({
          address: 'ak_b',
          read: i % 2 === 0,
          createdAt: daysAgo(0),
        }),
      );
    }
    const newestN = ids.slice(-cap); // ids are inserted in ascending/creation order
    const oldestExcess = ids.slice(0, ids.length - cap);

    await db.dataSource.transaction((manager) =>
      service.prune(manager, 90, cap, 10_000),
    );

    const survivors = await idsFor('ak_b');
    expect(survivors.sort((a, b) => a - b)).toEqual(
      newestN.sort((a, b) => a - b),
    );
    for (const oldId of oldestExcess) {
      expect(survivors).not.toContain(oldId);
    }
  });

  it('per-address cap leaves an under-cap address fully intact while trimming an over-cap one', async () => {
    const cap = 5;
    const underCapIds: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      underCapIds.push(
        await seed({ address: 'ak_under', read: false, createdAt: daysAgo(0) }),
      );
    }
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seed({ address: 'ak_over', read: false, createdAt: daysAgo(0) });
    }

    await db.dataSource.transaction((manager) =>
      service.prune(manager, 90, cap, 10_000),
    );

    // Untouched: 3 rows is under the 5-row cap.
    expect((await idsFor('ak_under')).sort((a, b) => a - b)).toEqual(
      underCapIds.sort((a, b) => a - b),
    );
    // Trimmed: 8 rows over a 5-row cap -> exactly 5 survive.
    expect(await idsFor('ak_over')).toHaveLength(cap);
  });
});

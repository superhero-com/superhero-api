import 'dotenv/config';
import { DataSource } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { NotificationRecord } from './notification.entity';
import { WebPushSubscription } from './web-push-subscription.entity';

/**
 * DB integration: apply `WebNotificationFeed1718900000020` on a real Postgres and
 * assert the `notifications` + `web_push_subscriptions` tables and every named
 * index exist, then revert and assert they are gone.
 *
 * Why this exists: production forces `synchronize: false` and runs
 * `migration:run` on container boot (see src/data-source.ts + Dockerfile) — the
 * `docs/notifications-announcements-manual-migration.sql` file is a convenience
 * doc that nothing executes. Without a real TypeORM migration these two tables
 * would simply not exist in production. This spec is the guarantee that the
 * migration (a) applies cleanly on a fresh DB and (b) actually produces the
 * schema the entities/services expect.
 *
 * Isolation: a fresh throwaway database (own private `public` schema), same
 * pattern as the TGR migration spec — see src/token-gated-rooms/entities/
 * migrations.integration.spec.ts. Skipped automatically when no DB host is
 * configured so unit-only runs stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('WebNotificationFeed migration (integration)', () => {
  let db: IsolatedDb;
  let ds: DataSource;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [NotificationRecord, WebPushSubscription],
      // Only this feature's migration — the TGR migrations in this directory
      // require a pre-existing `token` table (seeded elsewhere via
      // MINIMAL_TOKEN_TABLE_SQL) that is out of scope for this spec.
      migrations: [
        __dirname + '/../../migrations/1718900000020-WebNotificationFeed.ts',
      ],
    });
    ds = db.dataSource;
    await ds.runMigrations();
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await ds.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [name],
    );
    return rows.length > 0;
  };

  const indexExists = async (name: string): Promise<boolean> => {
    const rows = await ds.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
      [name],
    );
    return rows.length > 0;
  };

  it('creates the notifications and web_push_subscriptions tables', async () => {
    expect(await tableExists('notifications')).toBe(true);
    expect(await tableExists('web_push_subscriptions')).toBe(true);
  });

  it('creates the feed pagination / retention / unread indexes', async () => {
    expect(await indexExists('notifications_address_id_idx')).toBe(true);
    expect(await indexExists('notifications_address_read_at_idx')).toBe(true);
    expect(await indexExists('notifications_retention_idx')).toBe(true);
    // Superseded index must not exist (up() explicitly drops it if present).
    expect(await indexExists('notifications_address_created_at_idx')).toBe(
      false,
    );
  });

  it('the retention index is a partial index on read rows only', async () => {
    const rows = await ds.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'notifications_retention_idx'`,
    );
    expect(rows[0].indexdef).toMatch(/WHERE \(read_at IS NOT NULL\)/i);
  });

  it('creates the web_push_subscriptions indexes, endpoint UNIQUE', async () => {
    expect(await indexExists('web_push_subscriptions_address_idx')).toBe(true);
    expect(await indexExists('web_push_subscriptions_endpoint_uq')).toBe(true);
    const rows = await ds.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'web_push_subscriptions_endpoint_uq'`,
    );
    expect(rows[0].indexdef).toMatch(/CREATE UNIQUE INDEX/i);
  });

  it('the schema actually accepts writes shaped like the entities', async () => {
    await ds.query(
      `INSERT INTO notifications (address, type, title, body) VALUES ($1, $2, $3, $4)`,
      ['ak_test', 'post-comment', 'title', 'body'],
    );
    const [{ count }] = await ds.query(
      `SELECT count(*)::int AS count FROM notifications WHERE address = 'ak_test'`,
    );
    expect(count).toBe(1);

    await ds.query(
      `INSERT INTO web_push_subscriptions (address, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)`,
      ['ak_test', 'https://push.example/x', 'p', 'a'],
    );
    // Unique endpoint is enforced.
    await expect(
      ds.query(
        `INSERT INTO web_push_subscriptions (address, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)`,
        ['ak_other', 'https://push.example/x', 'p2', 'a2'],
      ),
    ).rejects.toThrow();
  });

  it('down() drops both tables', async () => {
    // Revert just this migration (the last one applied).
    await ds.undoLastMigration();
    expect(await tableExists('web_push_subscriptions')).toBe(false);
    expect(await tableExists('notifications')).toBe(false);
  });
});

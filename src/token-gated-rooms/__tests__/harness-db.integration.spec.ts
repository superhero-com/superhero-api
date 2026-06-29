import 'dotenv/config';
import { DataSource } from 'typeorm';
import { DATABASE_CONFIG } from '@/configs/database';
import {
  createIsolatedDatabase,
  dropDatabase,
  MINIMAL_TOKEN_TABLE_SQL,
} from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '@/token-gated-rooms/entities/community-room.entity';
import { RoomMembership } from '@/token-gated-rooms/entities/room-membership.entity';
import { RoomNotificationPreference } from '@/token-gated-rooms/entities/room-notification-preference.entity';
import { RoomMessageSeen } from '@/token-gated-rooms/entities/room-message-seen.entity';
import { TokenBalance } from '@/token-gated-rooms/entities/token-balance.entity';
import { RoomBackfillState } from '@/token-gated-rooms/entities/room-backfill-state.entity';

/**
 * Task 02 harness self-test (DB isolation). Proves `createIsolatedDatabase`:
 *   - provisions a brand-new throwaway database,
 *   - applies the real TGR migrations into it (no `synchronize`),
 *   - a `token` row written through the migrated schema reads back with the new
 *     TGR columns present (`nostr_room_state` defaulting to `'none'`),
 *   - `drop()` removes the database (asserted gone via `pg_database`),
 *   - and the whole thing never touches the shared application database.
 *
 * Auto-skips when `DB_HOST` is unset so unit-only runs stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

async function databaseExists(name: string): Promise<boolean> {
  const admin = new DataSource({
    ...(DATABASE_CONFIG as any),
    synchronize: false,
    entities: [],
    migrations: [],
  });
  await admin.initialize();
  try {
    const rows = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [name],
    );
    return rows.length > 0;
  } finally {
    await admin.destroy();
  }
}

d('harness/db: isolated throwaway database (self-test)', () => {
  it('creates a DB, runs migrations, round-trips a token, then drops it', async () => {
    const db = await createIsolatedDatabase({
      entities: [
        Token,
        CommunityRoom,
        RoomMembership,
        RoomNotificationPreference,
        RoomMessageSeen,
        TokenBalance,
        RoomBackfillState,
      ],
      seedSql: [MINIMAL_TOKEN_TABLE_SQL],
    });

    try {
      // The throwaway DB exists and is isolated from the shared app DB.
      expect(await databaseExists(db.name)).toBe(true);
      expect(db.name).not.toBe((DATABASE_CONFIG as any).database);

      await db.dataSource.runMigrations();

      // Insert a token directly and read the new TGR columns back.
      await db.dataSource.query(`INSERT INTO "token" ("address") VALUES ($1)`, [
        'ct_harness_selftest',
      ]);
      const rows = await db.dataSource.query(
        `SELECT "address", "has_nostr_room", "nostr_room_state" FROM "token" WHERE "address" = $1`,
        ['ct_harness_selftest'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].has_nostr_room).toBe(false);
      expect(rows[0].nostr_room_state).toBe('none');
    } finally {
      // Drop via the handle; belt-and-braces drop by name in case it threw mid-way.
      await db.drop().catch(() => dropDatabase(db.name).catch(() => undefined));
    }

    // The database is gone after teardown.
    expect(await databaseExists(db.name)).toBe(false);
  }, 60_000);

  it('refuses to drop the shared application database', async () => {
    const appDb = (DATABASE_CONFIG as any).database as string;
    await expect(dropDatabase(appDb)).rejects.toThrow(/refusing to drop/i);
  });
});

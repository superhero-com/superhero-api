import 'dotenv/config';
import { BigNumber } from 'bignumber.js';
import { DataSource } from 'typeorm';
import {
  createIsolatedDatabase,
  IsolatedDb,
  MINIMAL_TOKEN_TABLE_SQL,
} from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from './community-room.entity';
import { RoomMembership } from './room-membership.entity';
import { RoomNotificationPreference } from './room-notification-preference.entity';
import { RoomMessageSeen } from './room-message-seen.entity';
import { TokenBalance } from './token-balance.entity';
import { RoomBackfillState } from './room-backfill-state.entity';

/**
 * DB integration (Task 00): apply the ordered TGR migrations on a real Postgres and
 * assert the TGR tables + 4 Token columns + named indexes + enum types exist, then
 * revert every migration and assert they are gone.
 *
 * Hermetic isolation (Task 02 harness): the migrations hard-code the `"public"`
 * schema and `ALTER TABLE "token"`, so a *dedicated schema* on the shared DB is
 * not enough — the enum types and `"public".*` references would still collide
 * with the shared `public` schema (left dirty by another integration spec or a
 * prior `npm run migration:run`). Instead we provision a brand-new **throwaway
 * database** per run (`createIsolatedDatabase`): its private `public` schema means
 * every migration object is scoped to this run, so up()/revert() are deterministic
 * regardless of the shared DB's state, and `afterAll` drops the whole database.
 *
 * Requires the local Postgres (DB_* env / repo .env). Skipped automatically when
 * no DB host is configured so unit-only runs stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('TGR migrations (integration)', () => {
  let db: IsolatedDb;
  let ds: DataSource;

  beforeAll(async () => {
    // A brand-new database with a minimal `token` table (migration #1 alters it).
    // The throwaway DB's `public` schema is private to this run, so the real
    // up()/down() path runs against a guaranteed-clean slate.
    db = await createIsolatedDatabase({
      entities: [
        Token,
        CommunityRoom,
        RoomMembership,
        RoomNotificationPreference,
        RoomMessageSeen,
        TokenBalance,
        RoomBackfillState,
      ],
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      seedSql: [MINIMAL_TOKEN_TABLE_SQL],
    });
    ds = db.dataSource;
    await ds.runMigrations();
  }, 60_000);

  afterAll(async () => {
    // Drop the entire throwaway database — no shared state to clean up.
    if (db) await db.drop();
  }, 60_000);

  const tableExists = async (name: string): Promise<boolean> => {
    const rows = await ds.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [name],
    );
    return rows.length > 0;
  };

  const columnExists = async (
    table: string,
    column: string,
  ): Promise<boolean> => {
    const rows = await ds.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
      [table, column],
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

  const enumExists = async (name: string): Promise<boolean> => {
    const rows = await ds.query(
      `SELECT 1 FROM pg_type WHERE typtype='e' AND typname=$1`,
      [name],
    );
    return rows.length > 0;
  };

  it('creates all TGR tables', async () => {
    for (const t of [
      'community_room',
      'room_membership',
      'room_membership_event',
      'room_notification_preference',
      'room_message_seen',
      'token_balance',
      'room_backfill_state',
    ]) {
      expect(await tableExists(t)).toBe(true);
    }
  });

  it('adds the 4 Token columns', async () => {
    for (const c of [
      'nostr_group_id',
      'has_nostr_room',
      'nostr_room_created_at',
      'nostr_room_state',
    ]) {
      expect(await columnExists('token', c)).toBe(true);
    }
  });

  it('creates the named partial / compound / unique indexes', async () => {
    for (const idx of [
      'idx_token_nostr_room_state_pending',
      'uq_room_membership_sale_member',
      'idx_room_membership_sale_relay_state',
      'idx_room_membership_member_address',
      'idx_room_membership_eligible',
      'idx_community_room_is_private',
      'idx_community_room_state_synced_at',
      'idx_community_room_moderators',
      'idx_community_room_muted',
      'idx_room_message_seen_sale_address',
    ]) {
      expect(await indexExists(idx)).toBe(true);
    }
  });

  it('partial indexes carry their WHERE predicate', async () => {
    const rows = await ds.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexname IN ($1,$2)`,
      ['idx_token_nostr_room_state_pending', 'idx_room_membership_eligible'],
    );
    const byName = Object.fromEntries(
      rows.map((r: any) => [r.indexname, r.indexdef]),
    );
    expect(byName['idx_token_nostr_room_state_pending']).toMatch(
      /WHERE .*nostr_room_state <> 'created'/i,
    );
    expect(byName['idx_room_membership_eligible']).toMatch(
      /WHERE .*eligible = true/i,
    );
  });

  it('GIN-indexes the jsonb moderators/muted columns', async () => {
    const rows = await ds.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexname IN ($1,$2)`,
      ['idx_community_room_moderators', 'idx_community_room_muted'],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.indexdef).toMatch(/USING gin/i);
    }
  });

  it('creates the Postgres enum types', async () => {
    for (const e of [
      'token_nostr_room_state_enum',
      'room_membership_role_enum',
      'room_membership_relay_state_enum',
      'room_membership_access_state_enum',
      'room_membership_event_event_enum',
    ]) {
      expect(await enumExists(e)).toBe(true);
    }
  });

  it('round-trips raw base units through numeric columns (no precision loss)', async () => {
    const repo = ds.getRepository(TokenBalance);
    const raw = '123456789012345678901234'; // > Number.MAX_SAFE_INTEGER
    await repo.save(
      repo.create({
        token_address: 'ct_integration_test_token',
        holder_address: 'ak_integration_test_holder',
        balance: new BigNumber(raw),
        updated_height: 1,
      }),
    );
    const found = await repo.findOneByOrFail({
      token_address: 'ct_integration_test_token',
      holder_address: 'ak_integration_test_holder',
    });
    expect(found.balance.toFixed()).toBe(raw);
    await repo.delete({
      token_address: 'ct_integration_test_token',
      holder_address: 'ak_integration_test_holder',
    });
  });

  it('reverting every migration removes the tables, Token columns and enum types', async () => {
    // Drain ALL applied migrations (count-independent, so adding a migration never
    // silently leaves a hardcoded loop under-reverting). `undoLastMigration` throws
    // once there is nothing left to revert.
    for (let i = 0; i < 100; i++) {
      try {
        await ds.undoLastMigration();
      } catch {
        break;
      }
    }

    for (const t of [
      'community_room',
      'room_membership',
      'room_membership_event',
      'room_notification_preference',
      'room_message_seen',
      'token_balance',
      'room_backfill_state',
    ]) {
      expect(await tableExists(t)).toBe(false);
    }
    for (const c of [
      'nostr_group_id',
      'has_nostr_room',
      'nostr_room_created_at',
      'nostr_room_state',
    ]) {
      expect(await columnExists('token', c)).toBe(false);
    }
    for (const e of [
      'token_nostr_room_state_enum',
      'room_membership_role_enum',
      'room_membership_relay_state_enum',
      'room_membership_access_state_enum',
      'room_membership_event_event_enum',
    ]) {
      expect(await enumExists(e)).toBe(false);
    }
  });
});

import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { DATABASE_CONFIG } from '@/configs/database';
import { Account } from '@/account/entities/account.entity';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '@/token-gated-rooms/entities/community-room.entity';
import { RoomMembership } from '@/token-gated-rooms/entities/room-membership.entity';
import { RoomNotificationPreference } from '@/token-gated-rooms/entities/room-notification-preference.entity';
import { RoomMessageSeen } from '@/token-gated-rooms/entities/room-message-seen.entity';
import { TokenBalance } from '@/token-gated-rooms/entities/token-balance.entity';
import { RoomBackfillState } from '@/token-gated-rooms/entities/room-backfill-state.entity';
import { IdentityService } from '@/token-gated-rooms/services/identity.service';
import { IdentityBackfillService } from '@/token-gated-rooms/services/identity-backfill.service';
import { TGR_LINK_CHANGED } from '@/token-gated-rooms/events';
import tgrConfig from '@/token-gated-rooms/config/tgr.config';

/**
 * DB integration for Task 05 identity resolution. Applies the TGR migrations on
 * the real local Postgres (DB_* env / repo .env), seeds `accounts` with mixed
 * `links` + `room_membership` rows, then exercises:
 *   - the one-time backfill → member_pubkey populated for linked holders, null
 *     for unlinked, none malformed (unlinked invariant §6.6);
 *   - a reactive link change (`tgr.link.changed`) for a previously-unlinked
 *     holder → member_pubkey re-resolved + the signal re-fanned-out.
 *
 * Mirrors `src/token-gated-rooms/entities/migrations.integration.spec.ts`: an
 * isolated migrations history table + best-effort drop so it owns a clean slate
 * on the shared `public` schema.
 *
 * `nostr-tools/nip19` is mocked (the real module pulls in @noble/* ESM that
 * ts-jest can't transform) with a fixed npub↔hex pair so normalization is real.
 */
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const NPUB_B = 'npub1bbbb';

jest.mock('nostr-tools/nip19', () => ({
  decode: (value: string) => {
    if (value === NPUB_B) return { type: 'npub', data: 'b'.repeat(64) };
    throw new Error('invalid bech32');
  },
}));

const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const PROVIDER = 'nostr';

// Holders covering each branch.
const A_HEX = 'ak_int_hexlinked';
const A_NPUB = 'ak_int_npublinked';
const A_NONE = 'ak_int_nonostr';
const A_OTHER = 'ak_int_otheronly';
const A_MALFORMED = 'ak_int_malformed';
const A_LATELINK = 'ak_int_latelink'; // unlinked at backfill, linked later
const SALE = 'ct_int_sale_identity';

async function dropTgrObjects(ds: DataSource): Promise<void> {
  const stmts = [
    `DROP TABLE IF EXISTS "room_backfill_state"`,
    `DROP TABLE IF EXISTS "token_balance"`,
    `DROP TABLE IF EXISTS "room_message_seen"`,
    `DROP TABLE IF EXISTS "room_notification_preference"`,
    `DROP TABLE IF EXISTS "room_membership"`,
    `DROP TABLE IF EXISTS "community_room"`,
    `DROP TYPE IF EXISTS "room_membership_relay_state_enum"`,
    `DROP TYPE IF EXISTS "room_membership_role_enum"`,
    `ALTER TABLE "token" DROP COLUMN IF EXISTS "nostr_room_state"`,
    `ALTER TABLE "token" DROP COLUMN IF EXISTS "nostr_room_created_at"`,
    `ALTER TABLE "token" DROP COLUMN IF EXISTS "has_nostr_room"`,
    `ALTER TABLE "token" DROP COLUMN IF EXISTS "nostr_group_id"`,
    `DROP TYPE IF EXISTS "token_nostr_room_state_enum"`,
  ];
  for (const s of stmts) {
    await ds.query(s);
  }
  await ds
    .query(`DELETE FROM "migrations" WHERE "name" LIKE 'Tgr%'`)
    .catch(() => undefined);
}

d('IdentityService / IdentityBackfillService (integration)', () => {
  let ds: DataSource;
  let moduleRef: TestingModule;
  let identity: IdentityService;
  let backfill: IdentityBackfillService;
  let accountRepo: Repository<Account>;
  let membershipRepo: Repository<RoomMembership>;
  let eventEmitter: EventEmitter2;

  beforeAll(async () => {
    // 1) Apply TGR migrations on the live DB via an isolated history table.
    ds = new DataSource({
      ...(DATABASE_CONFIG as any),
      synchronize: false,
      entities: [
        Token,
        Account,
        CommunityRoom,
        RoomMembership,
        RoomNotificationPreference,
        RoomMessageSeen,
        TokenBalance,
        RoomBackfillState,
      ],
      migrations: [__dirname + '/../../src/migrations/*{.ts,.js}'],
      migrationsTableName: 'migrations_tgr_identity_test',
    });
    await ds.initialize();
    await dropTgrObjects(ds);
    await ds.runMigrations();

    // 2) Nest module wiring the two services on the real DB + real event bus.
    moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        TypeOrmModule.forRoot({
          ...(DATABASE_CONFIG as any),
          synchronize: false,
          entities: [Account, RoomMembership, Token],
        }),
        TypeOrmModule.forFeature([Account, RoomMembership]),
      ],
      providers: [
        IdentityService,
        IdentityBackfillService,
        {
          provide: tgrConfig.KEY,
          useValue: { nostrLinkProvider: PROVIDER, backfillBatchSize: 2 },
        },
      ],
    }).compile();
    // init() so @OnEvent subscriptions register on the event bus.
    await moduleRef.init();

    identity = moduleRef.get(IdentityService);
    backfill = moduleRef.get(IdentityBackfillService);
    accountRepo = moduleRef.get(getRepositoryToken(Account));
    membershipRepo = moduleRef.get(getRepositoryToken(RoomMembership));
    eventEmitter = moduleRef.get(EventEmitter2);
  }, 90_000);

  afterAll(async () => {
    if (moduleRef) {
      await cleanupRows();
      await moduleRef.close();
    }
    if (ds?.isInitialized) {
      for (let i = 0; i < 7; i++) {
        await ds.undoLastMigration();
      }
      await ds.query('DROP TABLE IF EXISTS "migrations_tgr_identity_test"');
      await ds.destroy();
    }
  }, 90_000);

  const allAddresses = [
    A_HEX,
    A_NPUB,
    A_NONE,
    A_OTHER,
    A_MALFORMED,
    A_LATELINK,
  ];

  async function cleanupRows(): Promise<void> {
    await membershipRepo.delete({ sale_address: SALE });
    await accountRepo.delete(allAddresses.map((address) => ({ address })));
  }

  async function seed(): Promise<void> {
    await cleanupRows();
    await accountRepo.insert([
      { address: A_HEX, links: { [PROVIDER]: HEX_A } },
      { address: A_NPUB, links: { [PROVIDER]: NPUB_B } },
      { address: A_NONE, links: {} },
      { address: A_OTHER, links: { x: 'someone' } },
      { address: A_MALFORMED, links: { [PROVIDER]: 'deadbeef' } },
      { address: A_LATELINK, links: {} },
    ]);
    // One eligible membership row per holder (member_pubkey starts null).
    await membershipRepo.insert(
      allAddresses.map((member_address) => ({
        sale_address: SALE,
        member_address,
        eligible: true,
        relay_state: 'pending_add' as const,
      })),
    );
  }

  it('backfill populates member_pubkey for linked holders, null otherwise, none malformed', async () => {
    await seed();

    const result = await backfill.run({ batchSize: 2 });
    expect(result.scanned).toBe(allAddresses.length);

    const rows = await membershipRepo.find({ where: { sale_address: SALE } });
    const byAddr = Object.fromEntries(
      rows.map((r) => [r.member_address, r.member_pubkey]),
    );

    expect(byAddr[A_HEX]).toBe(HEX_A);
    expect(byAddr[A_NPUB]).toBe(HEX_B); // npub normalized to hex
    expect(byAddr[A_NONE]).toBeNull();
    expect(byAddr[A_OTHER]).toBeNull();
    // Unlinked invariant: malformed link → treated as unlinked (null), and the
    // row is left eligible / pending_add (never advanced, never the bad value).
    expect(byAddr[A_MALFORMED]).toBeNull();
    const malformedRow = rows.find((r) => r.member_address === A_MALFORMED)!;
    expect(malformedRow.eligible).toBe(true);
    expect(malformedRow.relay_state).toBe('pending_add');
    expect(byAddr[A_LATELINK]).toBeNull();

    // No row ever holds a non-HEX64 value.
    for (const r of rows) {
      if (r.member_pubkey !== null) {
        expect(/^[0-9a-f]{64}$/.test(r.member_pubkey)).toBe(true);
      }
    }

    // Read API resolves through cache/DB consistently.
    expect(await identity.getPubkeyForAddress(A_HEX)).toBe(HEX_A);
    expect(await identity.getPubkeyForAddress(A_NPUB)).toBe(HEX_B);
    expect(await identity.getPubkeyForAddress(A_NONE)).toBeNull();
    expect(await identity.getAddressForPubkey(HEX_A)).toBe(A_HEX);
    expect(await identity.getAddressForPubkey(NPUB_B)).toBe(A_NPUB);
  });

  it('reactive link change re-resolves member_pubkey and re-emits the signal', async () => {
    await seed();
    await backfill.run({ batchSize: 2 });

    // Simulate the address-links seam: the account links nostr, then the event
    // fires. We update the DB the way the reactive sync would, then emit.
    await accountRepo.update(
      { address: A_LATELINK },
      { links: { [PROVIDER]: HEX_A } },
    );

    // Capture the re-fanned-out signal. The @OnEvent handler runs with
    // emit:false (no re-broadcast), but we assert a *direct* reresolve re-emits
    // and that the @OnEvent path updates the DB.
    const seen: string[] = [];
    const listener = (p: { address: string }) => seen.push(p.address);
    eventEmitter.on(TGR_LINK_CHANGED, listener);

    // Drive the @OnEvent handler by emitting the seam event and awaiting all
    // async listeners.
    await eventEmitter.emitAsync(TGR_LINK_CHANGED, { address: A_LATELINK });

    eventEmitter.off(TGR_LINK_CHANGED, listener);

    const row = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: A_LATELINK,
    });
    expect(row.member_pubkey).toBe(HEX_A);

    // The originating emit reached our listener (and Task 06 would consume it
    // too); the handler itself must NOT re-broadcast (loop-guard).
    expect(seen).toEqual([A_LATELINK]);

    // A direct reresolve (e.g. backfill correction) DOES re-emit.
    const seen2: string[] = [];
    const l2 = (p: { address: string }) => seen2.push(p.address);
    eventEmitter.on(TGR_LINK_CHANGED, l2);
    await identity.reresolveAddress(A_LATELINK);
    eventEmitter.off(TGR_LINK_CHANGED, l2);
    expect(seen2).toEqual([A_LATELINK]);
  });

  it('unlink nulls member_pubkey across rooms', async () => {
    await seed();
    await backfill.run({ batchSize: 2 });
    expect(
      (
        await membershipRepo.findOneByOrFail({
          sale_address: SALE,
          member_address: A_HEX,
        })
      ).member_pubkey,
    ).toBe(HEX_A);

    // Unlink: remove the nostr key, then drive the handler.
    await accountRepo.update({ address: A_HEX }, { links: {} });
    await eventEmitter.emitAsync(TGR_LINK_CHANGED, { address: A_HEX });

    const row = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: A_HEX,
    });
    expect(row.member_pubkey).toBeNull();
    // Eligibility / relay_state untouched by this task.
    expect(row.eligible).toBe(true);
    expect(row.relay_state).toBe('pending_add');
  });
});

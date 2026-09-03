import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { BigNumber } from 'bignumber.js';
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
import { EligibilityService } from '@/token-gated-rooms/services/eligibility.service';
import {
  TGR_BALANCE_CHANGED,
  TGR_COMMUNITY_UPSERTED,
  TGR_ELIGIBILITY_CHANGED,
} from '@/token-gated-rooms/events';
import tgrConfig from '@/token-gated-rooms/config/tgr.config';

/**
 * DB integration for Task 06 eligibility. Applies the TGR migrations on the real
 * local Postgres (DB_* env / repo .env) via an isolated migrations history table
 * (mirrors `identity.int-spec.ts` / `migrations.integration.spec.ts`), then drives
 * the real {@link EligibilityService} through its event triggers and asserts the
 * desired-state `room_membership` rows + `tgr.eligibility.changed` emissions.
 *
 * `nostr-tools/nip19` is mocked (the real module pulls @noble/* ESM that ts-jest
 * cannot transform) with a fixed hex passthrough so {@link IdentityService}
 * normalization is real.
 */
const HEX = 'a'.repeat(64);

jest.mock('nostr-tools/nip19', () => ({
  decode: () => {
    throw new Error('invalid bech32');
  },
}));

const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const PROVIDER = 'nostr';
const SALE = 'ct_int_sale_eligibility';
const TOKEN = 'ct_int_token_eligibility';

/**
 * Private schema built by `synchronize`, same approach as
 * `community-room-state.integration.spec.ts`. This spec covers EligibilityService,
 * not migration SQL, so it has no reason to run migrations against the shared
 * `public` schema — doing so leaked TGR objects between runs and raced with
 * `balance-indexer.integration.spec.ts` in a parallel worker.
 */
const SCHEMA = 'tgr_eligibility_test';

d('EligibilityService (integration)', () => {
  let ds: DataSource;
  let moduleRef: TestingModule;
  let service: EligibilityService;
  let identity: IdentityService;
  let accountRepo: Repository<Account>;
  let roomRepo: Repository<CommunityRoom>;
  let membershipRepo: Repository<RoomMembership>;
  let balanceRepo: Repository<TokenBalance>;
  let eventEmitter: EventEmitter2;

  beforeAll(async () => {
    const boot = new DataSource({
      ...(DATABASE_CONFIG as any),
      synchronize: false,
      entities: [],
    });
    await boot.initialize();
    await boot.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await boot.query(`CREATE SCHEMA "${SCHEMA}"`);
    await boot.destroy();

    ds = new DataSource({
      ...(DATABASE_CONFIG as any),
      schema: SCHEMA,
      synchronize: true, // empty schema → entities create every table this spec needs
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
    });
    await ds.initialize();

    moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        TypeOrmModule.forRoot({
          ...(DATABASE_CONFIG as any),
          schema: SCHEMA,
          synchronize: false, // `ds` above already materialized the schema
          entities: [
            Account,
            CommunityRoom,
            RoomMembership,
            TokenBalance,
            Token,
          ],
        }),
        TypeOrmModule.forFeature([
          Account,
          CommunityRoom,
          RoomMembership,
          TokenBalance,
        ]),
      ],
      providers: [
        IdentityService,
        EligibilityService,
        {
          provide: tgrConfig.KEY,
          useValue: {
            nostrLinkProvider: PROVIDER,
            reconcileBatchSize: 2,
          },
        },
      ],
    }).compile();
    // init() so @OnEvent subscriptions register on the event bus.
    await moduleRef.init();

    service = moduleRef.get(EligibilityService);
    identity = moduleRef.get(IdentityService);
    accountRepo = moduleRef.get(getRepositoryToken(Account));
    roomRepo = moduleRef.get(getRepositoryToken(CommunityRoom));
    membershipRepo = moduleRef.get(getRepositoryToken(RoomMembership));
    balanceRepo = moduleRef.get(getRepositoryToken(TokenBalance));
    eventEmitter = moduleRef.get(EventEmitter2);
  }, 90_000);

  afterAll(async () => {
    if (moduleRef) {
      await cleanup();
      await moduleRef.close();
    }
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await ds.destroy();
    }
  }, 90_000);

  async function cleanup(): Promise<void> {
    await membershipRepo.delete({ sale_address: SALE });
    await balanceRepo.delete({ token_address: TOKEN });
    await roomRepo.delete({ sale_address: SALE });
    await accountRepo
      .createQueryBuilder()
      .delete()
      .where('address LIKE :p', { p: 'ak_int_elig_%' })
      .execute();
    identity.clearCacheEntry('ak_int_elig_member');
  }

  async function seedRoom(over: Partial<CommunityRoom> = {}): Promise<void> {
    await roomRepo.save(
      roomRepo.create({
        sale_address: SALE,
        token_address: TOKEN,
        symbol: 'TGR',
        owner_address: 'ak_int_elig_owner',
        is_private: false,
        min_token_threshold: new BigNumber('1000'),
        moderators: [],
        muted: [],
        is_community: true,
        deleted: false,
        ...over,
      }),
    );
  }

  beforeEach(async () => {
    await cleanup();
  });

  it('balance change flips eligibility: creates row eligible=true, pending_add, and emits', async () => {
    const member = 'ak_int_elig_member';
    await seedRoom();
    await accountRepo.insert({ address: member, links: { [PROVIDER]: HEX } });
    await balanceRepo.insert({
      token_address: TOKEN,
      holder_address: member,
      balance: new BigNumber('5000') as any,
    });

    const seen: any[] = [];
    const listener = (p: any) => seen.push(p);
    eventEmitter.on(TGR_ELIGIBILITY_CHANGED, listener);

    await eventEmitter.emitAsync(TGR_BALANCE_CHANGED, {
      tokenAddress: TOKEN,
      holderAddress: member,
    });

    eventEmitter.off(TGR_ELIGIBILITY_CHANGED, listener);

    const row = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: member,
    });
    expect(row.eligible).toBe(true);
    expect(row.member_pubkey).toBe(HEX);
    expect(row.relay_state).toBe('pending_add');
    expect(seen).toEqual([
      { saleAddress: SALE, memberAddress: member, eligible: true },
    ]);
  });

  it('muted user removed from eligible: flips to false + pending_remove on community upsert', async () => {
    const member = 'ak_int_elig_member';
    await seedRoom();
    await accountRepo.insert({ address: member, links: { [PROVIDER]: HEX } });
    await balanceRepo.insert({
      token_address: TOKEN,
      holder_address: member,
      balance: new BigNumber('5000') as any,
    });
    // Start from a published-eligible row.
    await membershipRepo.insert({
      sale_address: SALE,
      member_address: member,
      eligible: true,
      role: 'member',
      member_pubkey: HEX,
      relay_state: 'added',
    });

    // Mute them at the room level, then signal the upsert.
    await roomRepo.update({ sale_address: SALE }, { muted: [member] });

    const seen: any[] = [];
    const listener = (p: any) => seen.push(p);
    eventEmitter.on(TGR_ELIGIBILITY_CHANGED, listener);

    await eventEmitter.emitAsync(TGR_COMMUNITY_UPSERTED, {
      saleAddress: SALE,
    });

    eventEmitter.off(TGR_ELIGIBILITY_CHANGED, listener);

    const row = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: member,
    });
    expect(row.eligible).toBe(false);
    expect(row.relay_state).toBe('pending_remove');
    expect(seen).toEqual([
      { saleAddress: SALE, memberAddress: member, eligible: false },
    ]);
  });

  it('cursor-batched recompute: every member of a room with > N members is recomputed', async () => {
    await seedRoom(); // reconcileBatchSize = 2 → forces multiple batches
    const count = 5;
    const members = Array.from(
      { length: count },
      (_, i) => `ak_int_elig_m${i.toString().padStart(2, '0')}`,
    );

    // All linked + all above threshold → all should become eligible.
    for (const m of members) {
      await accountRepo.insert({ address: m, links: { [PROVIDER]: HEX } });
      await balanceRepo.insert({
        token_address: TOKEN,
        holder_address: m,
        balance: new BigNumber('5000') as any,
      });
      // Pre-create the membership rows (ineligible) so the cursor scan has rows.
      await membershipRepo.insert({
        sale_address: SALE,
        member_address: m,
        eligible: false,
        role: 'member',
        relay_state: 'removed',
      });
    }

    const flips = await service.recomputeRoom(SALE);
    expect(flips).toBe(count);

    const rows = await membershipRepo.find({ where: { sale_address: SALE } });
    expect(rows).toHaveLength(count);
    for (const r of rows) {
      expect(r.eligible).toBe(true);
      expect(r.relay_state).toBe('pending_add');
      expect(r.member_pubkey).toBe(HEX);
    }
  });

  it('idempotency: a second recompute with unchanged inputs writes nothing and emits nothing', async () => {
    const member = 'ak_int_elig_member';
    await seedRoom();
    await accountRepo.insert({ address: member, links: { [PROVIDER]: HEX } });
    await balanceRepo.insert({
      token_address: TOKEN,
      holder_address: member,
      balance: new BigNumber('5000') as any,
    });

    const room = await roomRepo.findOneByOrFail({ sale_address: SALE });
    // First compute creates the row.
    await service.recomputeMember(room, member);
    const before = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: member,
    });

    const seen: any[] = [];
    const listener = (p: any) => seen.push(p);
    eventEmitter.on(TGR_ELIGIBILITY_CHANGED, listener);

    const flipped = await service.recomputeMember(room, member);

    eventEmitter.off(TGR_ELIGIBILITY_CHANGED, listener);

    expect(flipped).toBe(false);
    expect(seen).toEqual([]);
    const after = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: member,
    });
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });
});

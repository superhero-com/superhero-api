import 'dotenv/config';
import { BigNumber } from 'bignumber.js';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomStateService } from './room-state.service';
import { CommunityRoomBackfillService } from './community-room-backfill.service';
import { TGR_COMMUNITY_UPSERTED } from '../events';

/**
 * DB integration (Task 04; harness pattern mirrors Task 02 /
 * `entities/migrations.integration.spec.ts`): a real Postgres backs the backfill
 * and a simulated live management change. The chain reads (`get_state` /
 * `get_community_management`) are stubbed on `RoomStateService.getContract` so the
 * test is deterministic and offline; only the DB I/O is real.
 *
 * Isolation: runs in a DEDICATED `tgr04_test` schema (created/dropped here) with
 * `synchronize: true`, so `token` + `community_room` contain ONLY the seeds of
 * this test — the whole-registry backfill is naturally scoped and never touches
 * the shared `public` schema (which holds 54k real tokens).
 *
 * Asserts:
 *  - backfill populates `community_room` for a mix of community + `[TG]` tokens,
 *    stamps `state_synced_at`, processes stalest-first, and is resumable after a
 *    mid-run interruption;
 *  - re-running over synced rooms is idempotent (no events);
 *  - a simulated management change re-reads + updates the row and re-emits
 *    `tgr.community.upserted` with the diff;
 *  - raw thresholds round-trip through numeric without precision loss.
 *
 * Requires the local Postgres (`DB_HOST`); auto-skips otherwise so unit-only runs
 * stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const SCHEMA = 'tgr04_test';
const SALE_COMMUNITY = 'ct_tgr04_sale_community';
const SALE_TG = 'ct_tgr04_sale_tg';
const TOKEN_COMMUNITY = 'ct_tgr04_token_community';
const TOKEN_TG = 'ct_tgr04_token_tg';
const MGMT = 'ct_tgr04_mgmt';

d('Community-room state indexer (integration)', () => {
  let ds: DataSource;
  let tokenRepo: Repository<Token>;
  let roomRepo: Repository<CommunityRoom>;
  let emitter: EventEmitter2;
  let roomState: RoomStateService;
  let backfill: CommunityRoomBackfillService;

  // Mutable chain state our stubbed contract reads return.
  let managementBySale: Record<string, string | undefined>;
  let stateByMgmt: Record<string, any>;

  const installChainStub = (svc: RoomStateService) => {
    (svc as any).getContract = jest.fn(async (address: string) => {
      if (address in stateByMgmt) {
        return {
          get_state: async () => ({ decodedResult: stateByMgmt[address] }),
        };
      }
      // factory
      return {
        get_community_management: async (sale: string) => ({
          decodedResult: managementBySale[sale],
        }),
      };
    });
  };

  beforeAll(async () => {
    // Bootstrap the isolated schema on a throwaway connection.
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
      synchronize: true, // empty schema → entities create token + community_room
      entities: [Token, CommunityRoom],
    });
    await ds.initialize();

    tokenRepo = ds.getRepository(Token);
    roomRepo = ds.getRepository(CommunityRoom);
    emitter = new EventEmitter2();
    roomState = new RoomStateService(
      roomRepo,
      { sdk: { getContext: () => ({}) } } as any,
      emitter,
    );
    installChainStub(roomState);
    backfill = new CommunityRoomBackfillService(
      tokenRepo,
      roomRepo,
      roomState,
      emitter,
      new SchedulerRegistry(),
      { backfillBatchSize: 1, roomProvisionBatchSize: 500 } as any, // tiny batches exercise resumability
    );
  }, 60_000);

  beforeEach(async () => {
    await roomRepo.clear();
    await tokenRepo.clear();

    await tokenRepo.save([
      tokenRepo.create({
        sale_address: SALE_COMMUNITY,
        address: TOKEN_COMMUNITY,
        name: 'CommunityToken',
        symbol: 'COMM',
        owner_address: 'ak_comm_owner',
        creator_address: 'ak_comm_creator',
        last_sync_block_height: 500,
      }),
      tokenRepo.create({
        sale_address: SALE_TG,
        address: TOKEN_TG,
        name: 'TgToken',
        symbol: 'TG',
        owner_address: 'ak_tg_owner',
        creator_address: 'ak_tg_creator',
        last_sync_block_height: 600,
      }),
    ]);

    managementBySale = {
      [SALE_COMMUNITY]: MGMT,
      [SALE_TG]: undefined, // None → [TG] defaults
    };
    stateByMgmt = {
      [MGMT]: {
        owner: 'ak_dao_owner',
        minimum_token_threshold: 1000000000000000000n,
        is_private: true,
        moderator_accounts: new Set(['ak_mod_1']),
        muted_user_ids: new Set(['npub_mute_1']),
        meta_info: new Map(),
      },
    };
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    const cleanup = new DataSource({
      ...(DATABASE_CONFIG as any),
      synchronize: false,
      entities: [],
    });
    await cleanup.initialize();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await cleanup.destroy();
  }, 60_000);

  it('backfill populates community_room for community + [TG] tokens, stamping state_synced_at', async () => {
    const result = await backfill.run();
    expect(result.processed).toBe(2);

    const community = await roomRepo.findOneByOrFail({
      sale_address: SALE_COMMUNITY,
    });
    expect(community.is_community).toBe(true);
    expect(community.is_private).toBe(true);
    expect(community.owner_address).toBe('ak_dao_owner');
    expect(community.min_token_threshold.toFixed()).toBe('1000000000000000000');
    expect(community.moderators).toEqual(['ak_mod_1']);
    expect(community.muted).toEqual(['npub_mute_1']);
    expect(community.state_synced_at).toBeInstanceOf(Date);
    expect(community.created_height).toBe(500);

    const tg = await roomRepo.findOneByOrFail({ sale_address: SALE_TG });
    expect(tg.is_community).toBe(false);
    expect(tg.is_private).toBe(false);
    expect(tg.min_token_threshold.toFixed()).toBe('0');
    expect(tg.moderators).toEqual([]);
    expect(tg.muted).toEqual([]);
    expect(tg.owner_address).toBe('ak_tg_owner');
    expect(tg.state_synced_at).toBeInstanceOf(Date);
  });

  it('processes the stalest-first and is resumable after a mid-run interruption', async () => {
    // Process only the first (stalest / never-synced) token, then "crash".
    const first = await backfill.run({ maxBatches: 1 });
    expect(first.processed).toBe(1);
    expect(await roomRepo.count()).toBe(1); // exactly one room synced so far

    // Re-run: the already-synced row drops out of the NULLS-FIRST selection, so
    // only the remaining token is processed → run completes the rest.
    const second = await backfill.run();
    expect(second.processed).toBe(1);
    expect(await roomRepo.count()).toBe(2);
  });

  it('re-running over already-synced rooms emits nothing (idempotent)', async () => {
    await backfill.run();
    const events: any[] = [];
    emitter.on(TGR_COMMUNITY_UPSERTED, (p) => events.push(p));

    // Force a full re-sweep by clearing the cursor (simulate a reconcile pass).
    await ds.query(
      `UPDATE "${SCHEMA}"."community_room" SET "state_synced_at" = NULL`,
    );
    const result = await backfill.run();

    expect(result.processed).toBe(2);
    expect(result.emitted).toBe(0); // nothing changed → no events
    expect(events).toHaveLength(0);
  });

  it('a live management change updates the row and emits the diff', async () => {
    await backfill.run(); // seed the community room

    const received: any[] = [];
    emitter.on(TGR_COMMUNITY_UPSERTED, (p) => received.push(p));

    // Simulate the on-chain change: threshold up, add a moderator, mute someone.
    stateByMgmt[MGMT] = {
      owner: 'ak_dao_owner',
      minimum_token_threshold: 2000000000000000000n,
      is_private: true,
      moderator_accounts: new Set(['ak_mod_1', 'ak_mod_2']),
      muted_user_ids: new Set(['npub_mute_1', 'npub_mute_2']),
      meta_info: new Map(),
    };

    const token = await tokenRepo.findOneByOrFail({
      sale_address: SALE_COMMUNITY,
    });
    const upsert = await roomState.readAndUpsertRoomState(token);
    expect(upsert.emitted).toBe(true);

    const row = await roomRepo.findOneByOrFail({
      sale_address: SALE_COMMUNITY,
    });
    expect(row.min_token_threshold.toFixed()).toBe('2000000000000000000');
    expect([...row.moderators].sort()).toEqual(['ak_mod_1', 'ak_mod_2']);
    expect([...row.muted].sort()).toEqual(['npub_mute_1', 'npub_mute_2']);

    expect(received).toHaveLength(1);
    const payload = received[0];
    expect(payload.saleAddress).toBe(SALE_COMMUNITY);
    expect(payload.changed.threshold).toBe(true);
    expect(payload.changed.moderators).toEqual({
      added: ['ak_mod_2'],
      removed: [],
    });
    expect(payload.changed.muted).toEqual({
      added: ['npub_mute_2'],
      removed: [],
    });
    expect(payload.changed.owner).toBeUndefined();
  });

  it('round-trips a raw 24-digit threshold through numeric (no precision loss)', async () => {
    const huge = '123456789012345678901234'; // > Number.MAX_SAFE_INTEGER
    stateByMgmt[MGMT].minimum_token_threshold = BigInt(huge);
    await backfill.run();
    const row = await roomRepo.findOneByOrFail({
      sale_address: SALE_COMMUNITY,
    });
    expect(row.min_token_threshold).toBeInstanceOf(BigNumber);
    expect(row.min_token_threshold.toFixed()).toBe(huge);
  });
});

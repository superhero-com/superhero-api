import 'dotenv/config';
import { DataSource, Repository } from 'typeorm';
import { Relay } from 'nostr-tools';
import WebSocket from 'ws';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { SyncState } from '@/mdw-sync/entities/sync-state.entity';
import { CommunityRoom } from '../../entities/community-room.entity';
import { RoomMembership } from '../../entities/room-membership.entity';
import { RoomNotificationPreference } from '../../entities/room-notification-preference.entity';
import { RoomMessageSeen } from '../../entities/room-message-seen.entity';
import { TokenBalance } from '../../entities/token-balance.entity';
import { RoomBackfillState } from '../../entities/room-backfill-state.entity';
import { NIP29_KIND } from '../../nostr/nip29';
import { ReconciliationService } from '../reconciliation.service';
import { ReorgEvictionService } from '../reorg-eviction.service';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

/**
 * DB integration for Task 11 (reconciliation diff + reorg buffer/flush). A real
 * Postgres backs `token` + `community_room` + `room_membership` + `sync_state` in a
 * DEDICATED `tgr11_test` schema (`synchronize: true`), mirroring the Task 09/10
 * harness. The relay WRITE path is MOCKED (we assert the enqueued `9000`/`9001`
 * templates) and the `39002` read-back is fed via a stubbed `fetchGroupMembers` —
 * the relay socket / read helper is Task 07's contract; here we drive the state
 * machine. Auto-skips when there is no local Postgres (`DB_HOST`).
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const SCHEMA = 'tgr11_test';
const SALE = 'ct_tgr11_sale';
const TOKEN_ADDR = 'ct_tgr11_token';
const MEMBER = 'ak_tgr11_member';
const PUBKEY = 'a'.repeat(64);
const DEPTH = 10;

void Relay; // imported for parity with sibling harnesses (relay section is mocked)

d('Task 11 reconciliation + reorg (integration)', () => {
  let ds: DataSource;
  let tokenRepo: Repository<Token>;
  let roomRepo: Repository<CommunityRoom>;
  let membershipRepo: Repository<RoomMembership>;
  let syncStateRepo: Repository<SyncState>;

  let publishQueue: { add: jest.Mock };
  let relayMembers: Set<string>;
  let reconciliation: ReconciliationService;
  let reorg: ReorgEvictionService;

  const config = {
    reconcileBatchSize: 500,
    reconcileIntervalSec: 600,
    reorgConfirmationDepthBlocks: DEPTH,
    publishMaxRetries: 5,
  } as any;

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
      synchronize: true,
      entities: [
        Token,
        SyncState,
        CommunityRoom,
        RoomMembership,
        RoomNotificationPreference,
        RoomMessageSeen,
        TokenBalance,
        RoomBackfillState,
      ],
    });
    await ds.initialize();

    tokenRepo = ds.getRepository(Token);
    roomRepo = ds.getRepository(CommunityRoom);
    membershipRepo = ds.getRepository(RoomMembership);
    syncStateRepo = ds.getRepository(SyncState);
  }, 60_000);

  beforeEach(async () => {
    await membershipRepo.clear();
    await roomRepo.clear();
    await tokenRepo.clear();
    await syncStateRepo.clear();

    publishQueue = { add: jest.fn().mockResolvedValue({ id: 'p' }) };
    relayMembers = new Set<string>();

    const relay = {
      pubkey: 'f'.repeat(64),
      isHealthy: () => true,
      publish: jest.fn(),
      fetchGroupMembers: jest.fn(async () => new Set(relayMembers)),
    };
    const roomAdmins = {
      isConfiguredAdmin: () => false,
      convergeRoomAdmins: jest.fn().mockResolvedValue(0),
    };

    reconciliation = new ReconciliationService(
      membershipRepo,
      tokenRepo,
      syncStateRepo,
      publishQueue as unknown as any,
      relay as any,
      roomAdmins as any,
      config,
    );
    reorg = new ReorgEvictionService(
      membershipRepo,
      tokenRepo,
      syncStateRepo,
      publishQueue as unknown as any,
      roomAdmins as any,
      config,
    );
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

  async function seedRoom(): Promise<void> {
    await tokenRepo.save(
      tokenRepo.create({
        sale_address: SALE,
        address: TOKEN_ADDR,
        name: 'TGR11',
        symbol: 'TGR',
        owner_address: 'ak_owner',
        nostr_group_id: SALE,
        nostr_room_state: 'created',
        has_nostr_room: true,
      } as Partial<Token>),
    );
    await roomRepo.save(
      roomRepo.create({
        sale_address: SALE,
        token_address: TOKEN_ADDR,
        symbol: 'TGR',
        owner_address: 'ak_owner',
        is_private: true,
        moderators: [],
        muted: [],
        is_community: true,
        deleted: false,
      }),
    );
  }

  async function setHeight(tip: number): Promise<void> {
    await syncStateRepo.save(
      syncStateRepo.create({
        id: 'global',
        last_synced_height: tip,
        last_synced_hash: 'mh_x',
        tip_height: tip,
      } as Partial<SyncState>),
    );
  }

  // ── §A drift heals ──────────────────────────────────────────────────────────

  it('drift heals: eligible+linked member missing from 39002 → republishes 9000, advances last_reconciled_at', async () => {
    await seedRoom();
    await setHeight(1000);
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        eligible: true,
        relay_state: 'added',
      }),
    );
    relayMembers = new Set(); // 39002 lost the member (dropped publish)

    const before = await membershipRepo.findOneByOrFail({ sale_address: SALE });
    expect(before.last_reconciled_at).toBeNull();

    const result = await reconciliation.reconcileBatch();

    expect(result.added).toBe(1);
    expect(publishQueue.add).toHaveBeenCalledTimes(1);
    expect(publishQueue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.PUT_USER,
    );
    const after = await membershipRepo.findOneByOrFail({ sale_address: SALE });
    expect(after.last_reconciled_at).toBeInstanceOf(Date);
  });

  it('stale-remove heals: ineligible member still in 39002 → republishes 9001', async () => {
    await seedRoom();
    await setHeight(1000);
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        eligible: false,
        relay_state: 'added',
      }),
    );
    relayMembers = new Set([PUBKEY]); // dropped 9001 → still present

    const result = await reconciliation.reconcileBatch();

    expect(result.removed).toBe(1);
    expect(publishQueue.add).toHaveBeenCalledTimes(1);
    expect(publishQueue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.REMOVE_USER,
    );
  });

  it('no drift → no spurious publishes (idempotent)', async () => {
    await seedRoom();
    await setHeight(1000);
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        eligible: true,
        relay_state: 'added',
      }),
    );
    relayMembers = new Set([PUBKEY]);

    await reconciliation.reconcileBatch();

    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  // ── §B reorg buffer + flush ───────────────────────────────────────────────────

  it('reorg within depth does NOT evict: bufferEvictions sets a future hold, flush publishes nothing', async () => {
    await seedRoom();
    await setHeight(1000);
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        eligible: false, // post-reorg recompute made them ineligible
        relay_state: 'added',
      }),
    );

    const buffered = await reorg.bufferEvictions([SALE]);
    expect(buffered).toBe(1);
    let row = await membershipRepo.findOneByOrFail({ sale_address: SALE });
    expect(row.held_until_height).toBe(1000 + DEPTH);
    expect(row.relay_state).toBe('added');

    // Advance height by < DEPTH → hold not passed → flush is a no-op.
    await setHeight(1000 + DEPTH - 1);
    const { published } = await reorg.flushDueEvictions();
    expect(published).toBe(0);
    expect(publishQueue.add).not.toHaveBeenCalled();
    row = await membershipRepo.findOneByOrFail({ sale_address: SALE });
    expect(row.held_until_height).toBe(1000 + DEPTH);
    expect(row.relay_state).toBe('added');
  });

  it('reorg beyond depth evicts: flush publishes 9001, clears hold, sets pending_remove', async () => {
    await seedRoom();
    await setHeight(1000);
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        eligible: false,
        relay_state: 'added',
      }),
    );

    await reorg.bufferEvictions([SALE]);
    await setHeight(1000 + DEPTH); // hold passed

    const { published } = await reorg.flushDueEvictions();
    expect(published).toBe(1);
    expect(publishQueue.add).toHaveBeenCalledTimes(1);
    expect(publishQueue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.REMOVE_USER,
    );
    const row = await membershipRepo.findOneByOrFail({ sale_address: SALE });
    expect(row.held_until_height).toBeNull();
    expect(row.relay_state).toBe('pending_remove');
  });

  it('transient fork cancels eviction: eligibility restored before depth → flush cancels, no 9001', async () => {
    await seedRoom();
    await setHeight(1000);
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        eligible: false,
        relay_state: 'added',
      }),
    );

    await reorg.bufferEvictions([SALE]);
    // A follow-up reorg restores eligibility before depth passes.
    await membershipRepo.update({ sale_address: SALE }, { eligible: true });
    await setHeight(1000 + DEPTH);

    const { published, cancelled } = await reorg.flushDueEvictions();
    // An eligible row is filtered out of the flush select entirely → not published,
    // and its hold is left for the next recompute to clear (no spurious 9001).
    expect(published).toBe(0);
    expect(cancelled).toBe(0);
    expect(publishQueue.add).not.toHaveBeenCalled();
    const row = await membershipRepo.findOneByOrFail({ sale_address: SALE });
    expect(row.relay_state).toBe('added');
  });

  // ── §A.8 buffer vs reconcile interaction ──────────────────────────────────────

  it('a row inside an unexpired reorg hold (still in 39002) is NOT reconciled as drift-to-remove', async () => {
    await seedRoom();
    await setHeight(1000);
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        eligible: false,
        relay_state: 'added',
        held_until_height: 1000 + DEPTH, // unexpired hold
      }),
    );
    relayMembers = new Set([PUBKEY]); // intentionally still in 39002

    const result = await reconciliation.reconcileBatch();

    expect(result.removed).toBe(0);
    expect(publishQueue.add).not.toHaveBeenCalled();
  });
});

import 'dotenv/config';
import { DataSource, Repository } from 'typeorm';
import { getPublicKey, nip19, Relay } from 'nostr-tools';
import WebSocket from 'ws';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationPreference } from '@/notifications/entities/notification-preference.entity';
import { NotificationPreferencesService } from '@/notifications/services/notification-preferences.service';
import { CommunityRoom } from '../../entities/community-room.entity';
import { RoomMembership } from '../../entities/room-membership.entity';
import { RoomNotificationPreference } from '../../entities/room-notification-preference.entity';
import { RoomMessageSeen } from '../../entities/room-message-seen.entity';
import { TokenBalance } from '../../entities/token-balance.entity';
import { RoomBackfillState } from '../../entities/room-backfill-state.entity';
import { RoomPreferencesService } from '../../services/room-preferences.service';
import { RelaySubscriberService } from '../relay-subscriber.service';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

/**
 * DB (+ optional relay) integration for the Task-14 relay subscriber. Mirrors the
 * Task-12 harness: a real Postgres backs the room/membership/seen tables in a
 * DEDICATED `tgr14_test` schema (`synchronize: true`). The enqueue sink + redis +
 * NotificationService dependencies are mocked, so the test asserts the
 * dedup/fan-out/recipient SQL over REAL Postgres.
 *
 * The relay-backed cases additionally require a reachable `groups_relay`; they are
 * auto-skipped when unreachable, so unit-only CI stays green without the container.
 *
 * Requires the local Postgres (`DB_HOST`); auto-skips otherwise.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const SCHEMA = 'tgr14_test';
const GID = 'ct_tgr14_sale';
const TOKEN_ADDR = 'ct_tgr14_token';

const RELAY_ADMIN_NSEC =
  process.env.TG_BOT_NSEC ||
  'nsec1dwg3l5mumawgr4xq4kc6klagytkj2w4s4kd2rrthy47g3v5mwx8qwrh7sx';
const RELAY_URL = process.env.TG_RELAY_URL || 'ws://localhost:7777';

async function relayReachable(url: string): Promise<boolean> {
  try {
    const relay = await Relay.connect(url);
    relay.close();
    return true;
  } catch {
    return false;
  }
}

function makeConfig(): any {
  return {
    nostrBotNsec: RELAY_ADMIN_NSEC,
    nostrRelayUrl: RELAY_URL,
    msgCoalesceWindowSec: 0, // immediate flush — deterministic assertions
    msgRateCap: 0,
    roomNotifyDepthBreak: 10000,
    subscriberShards: 1,
    communityTokenRefreshSec: 300,
    relayHealthPauseSec: 1,
  };
}

d('RelaySubscriberService (integration)', () => {
  let ds: DataSource;
  let tokenRepo: Repository<Token>;
  let roomRepo: Repository<CommunityRoom>;
  let membershipRepo: Repository<RoomMembership>;
  let seenRepo: Repository<RoomMessageSeen>;
  let roomPrefRepo: Repository<RoomNotificationPreference>;
  let notifPrefRepo: Repository<NotificationPreference>;
  let roomPreferences: RoomPreferencesService;
  let add: jest.Mock;
  let svc: RelaySubscriberService;

  const adminPubkey = (): string => {
    const decoded = nip19.decode(RELAY_ADMIN_NSEC);
    return getPublicKey(decoded.data as Uint8Array);
  };

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
        CommunityRoom,
        RoomMembership,
        RoomNotificationPreference,
        RoomMessageSeen,
        TokenBalance,
        RoomBackfillState,
        NotificationPreference,
      ],
    });
    await ds.initialize();

    tokenRepo = ds.getRepository(Token);
    roomRepo = ds.getRepository(CommunityRoom);
    membershipRepo = ds.getRepository(RoomMembership);
    seenRepo = ds.getRepository(RoomMessageSeen);
    roomPrefRepo = ds.getRepository(RoomNotificationPreference);
    notifPrefRepo = ds.getRepository(NotificationPreference);
  }, 60_000);

  beforeEach(async () => {
    await seenRepo.clear();
    await membershipRepo.clear();
    await roomPrefRepo.clear();
    await notifPrefRepo.clear();
    await roomRepo.clear();
    await tokenRepo.clear();

    await tokenRepo.save(
      tokenRepo.create({
        sale_address: GID,
        address: TOKEN_ADDR,
        name: 'TGR14',
        symbol: 'TGR',
        owner_address: 'ak_owner',
        nostr_room_state: 'created',
      } as Partial<Token>),
    );
    await roomRepo.save(
      roomRepo.create({
        sale_address: GID,
        token_address: TOKEN_ADDR,
        symbol: 'TGR',
        owner_address: 'ak_owner',
      } as Partial<CommunityRoom>),
    );
    // 3 added members: alice (author), bob, carol.
    await membershipRepo.save([
      membershipRepo.create({
        sale_address: GID,
        member_address: 'ak_alice',
        member_pubkey: 'pk_alice',
        relay_state: 'added',
      }),
      membershipRepo.create({
        sale_address: GID,
        member_address: 'ak_bob',
        member_pubkey: 'pk_bob',
        relay_state: 'added',
      }),
      membershipRepo.create({
        sale_address: GID,
        member_address: 'ak_carol',
        member_pubkey: 'pk_carol',
        relay_state: 'added',
      }),
      // A pending member must NOT be a recipient.
      membershipRepo.create({
        sale_address: GID,
        member_address: 'ak_dave',
        member_pubkey: 'pk_dave',
        relay_state: 'pending_add',
      }),
    ]);

    const notifPrefs = new NotificationPreferencesService(notifPrefRepo);
    roomPreferences = new RoomPreferencesService(roomPrefRepo, notifPrefs);

    add = jest.fn().mockResolvedValue({ id: 'job' });
    const notifyQueue = {
      add,
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, delayed: 0 }),
    } as any;
    const redis = {
      incrementWithCap: jest
        .fn()
        .mockResolvedValue({ count: 1, capped: false }),
    } as any;

    svc = new RelaySubscriberService(
      tokenRepo,
      roomRepo,
      membershipRepo,
      seenRepo,
      roomPreferences,
      redis,
      notifyQueue,
      makeConfig(),
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

  const chat = (id: string, authorPubkey: string): any => ({
    id,
    pubkey: authorPubkey,
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    content: 'gm',
    tags: [['h', GID]],
    sig: 'x',
  });

  it('member posts → one job per OTHER added member, none for the author', async () => {
    await svc.onEvent(chat('e1', 'pk_alice'));
    const recipients = add.mock.calls.map((c) => c[1].recipient).sort();
    expect(recipients).toEqual(['ak_bob', 'ak_carol']); // not alice, not dave
    const seen = await seenRepo.findOne({ where: { event_id: 'e1' } });
    expect(seen).not.toBeNull();
    expect(seen!.sale_address).toBe(GID);
  });

  it('muted member is excluded while others get a job', async () => {
    await roomPrefRepo.save(
      roomPrefRepo.create({
        address: 'ak_bob',
        sale_address: GID,
        muted: true,
      }),
    );
    await svc.onEvent(chat('e2', 'pk_alice'));
    const recipients = add.mock.calls.map((c) => c[1].recipient).sort();
    expect(recipients).toEqual(['ak_carol']);
  });

  it('redelivery of the same event id → no duplicate jobs (dedup holds)', async () => {
    await svc.onEvent(chat('e3', 'pk_alice'));
    expect(add).toHaveBeenCalledTimes(2);
    add.mockClear();
    await svc.onEvent(chat('e3', 'pk_alice'));
    expect(add).not.toHaveBeenCalled();
  });

  it('refreshSubscription loads only this shard from Token nostr_room_state=created', async () => {
    // A non-created room must NOT enter the subscription set.
    await tokenRepo.save(
      tokenRepo.create({
        sale_address: 'ct_pending',
        address: 'ct_pending_t',
        name: 'P',
        symbol: 'P',
        owner_address: 'ak_o',
        nostr_room_state: 'pending',
      } as Partial<Token>),
    );
    // refreshSubscription needs a live socket; skip the actual subscribe when no
    // relay, just assert loadShardGroupIds via the private accessor through the
    // documented behavior (the created room is present, the pending one is not).
    const ids = await (svc as any).loadShardGroupIds();
    expect(ids.has(GID)).toBe(true);
    expect(ids.has('ct_pending')).toBe(false);
  });

  // ── relay-backed (auto-skip when unreachable) ────────────────────────────────
  describe('against a live groups_relay', () => {
    let available = false;
    beforeAll(async () => {
      available =
        !!process.env.TG_RELAY_URL || (await relayReachable(RELAY_URL));
      if (!available) {
        // eslint-disable-next-line no-console
        console.warn(
          `[relay-subscriber.integration] skipping relay cases — no relay at ${RELAY_URL}`,
        );
      }
    }, 30_000);

    const itRelay = (name: string, fn: () => Promise<void>, timeout = 20_000) =>
      it(
        name,
        async () => {
          if (!available) {
            return;
          }
          await fn();
        },
        timeout,
      );

    itRelay('connects + completes NIP-42 AUTH as relay admin', async () => {
      await (svc as any).ensureConnected();
      expect(svc.isHealthy()).toBe(true);
      expect(svc.pubkey).toBe(adminPubkey());
      svc.onApplicationShutdown();
    });
  });
});

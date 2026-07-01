import 'dotenv/config';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Queue } from 'bull';
import { BigNumber } from 'bignumber.js';
import { Relay } from 'nostr-tools';
import WebSocket from 'ws';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomMembershipEvent } from '../entities/room-membership-event.entity';
import { RoomNotificationPreference } from '../entities/room-notification-preference.entity';
import { RoomMessageSeen } from '../entities/room-message-seen.entity';
import { TokenBalance } from '../entities/token-balance.entity';
import { RoomBackfillState } from '../entities/room-backfill-state.entity';
import { NIP29_KIND } from '../nostr/nip29';
import { RelayWriterService } from '../nostr/relay-writer.service';
import {
  TGR_MEMBERSHIP_CHANGED,
  type TgrMembershipChangedPayload,
} from '../events';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import { MembershipAccessService } from './membership-access.service';
import { MembershipSyncService } from './membership-sync.service';

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'undefined') {
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}

/**
 * DB (+ optional relay) integration for membership-sync (Task 10). Mirrors the
 * Task 09 backfill harness: a real Postgres backs `token` + `community_room` +
 * `room_membership` in a DEDICATED `tgr10_test` schema (`synchronize: true`), so
 * the desired-state ledger is naturally scoped and never touches `public`.
 *
 * The relay WRITE path (the `worker:publish-nip29` queue + processor) is the Task
 * 07 contract; here we MOCK the queue and drive the state machine by replaying the
 * `tgr.publish.ack` the publish processor would emit — exactly the seam Task 10
 * consumes. A relay socket is opened ONLY for the flagged relay section, which
 * publishes the enqueued templates straight through `RelayWriterService` (what the
 * processor does) and asserts the relay's `39002`/`39001` reflect them; it
 * auto-skips when no `groups_relay` is reachable.
 *
 * Requires the local Postgres (`DB_HOST`); auto-skips otherwise so unit-only runs
 * stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const SCHEMA = 'tgr10_test';
const SALE = 'ct_tgr10_sale';
const TOKEN_ADDR = 'ct_tgr10_token';
const MEMBER = 'ak_tgr10_member';
const PUBKEY = 'a'.repeat(64);

const RELAY_URL = process.env.TG_RELAY_URL || 'ws://localhost:8080';
const RELAY_ADMIN_NSEC =
  process.env.TG_BOT_NSEC ||
  'nsec1dwg3l5mumawgr4xq4kc6klagytkj2w4s4kd2rrthy47g3v5mwx8qwrh7sx';

async function relayReachable(url: string): Promise<boolean> {
  try {
    const relay = await Relay.connect(url);
    relay.close();
    return true;
  } catch {
    return false;
  }
}

d('MembershipSyncService (integration)', () => {
  let ds: DataSource;
  let tokenRepo: Repository<Token>;
  let roomRepo: Repository<CommunityRoom>;
  let membershipRepo: Repository<RoomMembership>;
  let emitter: EventEmitter2;
  let service: MembershipSyncService;
  let publishQueue: { add: jest.Mock };
  let isConfiguredAdmin: jest.Mock;

  /** Replay the ACK the publish processor would emit for one member publish. */
  const ack = (kind: number, pubkey = PUBKEY, ok = true): Promise<void> =>
    service.onPublishAck({ saleAddress: SALE, pubkey, kind, ok });

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
        RoomMembershipEvent,
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
  }, 60_000);

  beforeEach(async () => {
    await membershipRepo.clear();
    await roomRepo.clear();
    await tokenRepo.clear();

    emitter = new EventEmitter2();
    publishQueue = { add: jest.fn().mockResolvedValue({ id: 'p' }) } as any;
    isConfiguredAdmin = jest.fn().mockReturnValue(false);

    const membershipAccess = new MembershipAccessService(
      membershipRepo,
      ds.getRepository(RoomMembershipEvent),
      emitter,
      { accessRevokeGraceSec: 180 } as any,
    );

    service = new MembershipSyncService(
      membershipRepo,
      roomRepo,
      tokenRepo,
      publishQueue as unknown as Queue<PublishNip29Job>,
      { isConfiguredAdmin } as any,
      emitter,
      new SchedulerRegistry(),
      {
        publishMaxRetries: 5,
        reconcileBatchSize: 2,
        reconcileIntervalSec: 600,
      } as any,
      undefined, // groupMissing (optional)
      membershipAccess,
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

  async function seedCreatedRoom(
    over: Partial<CommunityRoom> = {},
  ): Promise<void> {
    await tokenRepo.save(
      tokenRepo.create({
        sale_address: SALE,
        address: TOKEN_ADDR,
        name: 'TGR10',
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
        min_token_threshold: new BigNumber('1000'),
        moderators: [],
        muted: [],
        is_community: true,
        deleted: false,
        ...over,
      }),
    );
  }

  it('eligibility flip → 9000 enqueued, ACK → relay_state=added + last_published_at + emits', async () => {
    await seedCreatedRoom();
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        role: 'member',
        eligible: true,
        relay_state: 'pending_add',
      }),
    );

    const seen: TgrMembershipChangedPayload[] = [];
    emitter.on(TGR_MEMBERSHIP_CHANGED, (p) => seen.push(p));

    await service.onEligibilityChanged({
      saleAddress: SALE,
      memberAddress: MEMBER,
      eligible: true,
    });

    expect(publishQueue.add).toHaveBeenCalledTimes(1);
    expect(publishQueue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.PUT_USER,
    );

    // No state change until the ACK arrives.
    let row = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: MEMBER,
    });
    expect(row.relay_state).toBe('pending_add');
    expect(row.last_published_at).toBeNull();

    await ack(NIP29_KIND.PUT_USER);

    row = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: MEMBER,
    });
    expect(row.relay_state).toBe('added');
    expect(row.last_published_at).toBeInstanceOf(Date);
    // The push is now emitted by the access-transition ledger with the enriched
    // payload (ledger event id + first-grant flag).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      saleAddress: SALE,
      memberAddress: MEMBER,
      relayState: 'added',
      isFirstGrant: true,
    });
    expect(seen[0].accessEventId).toBeDefined();
    // The row's effective-access state flips to granted.
    expect(row.access_state).toBe('granted');
  });

  it('eligibility off → 9001 enqueued, ACK → relay_state=removed', async () => {
    await seedCreatedRoom();
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: PUBKEY,
        role: 'member',
        eligible: false,
        relay_state: 'pending_remove',
      }),
    );

    await service.onEligibilityChanged({
      saleAddress: SALE,
      memberAddress: MEMBER,
      eligible: false,
    });
    expect(publishQueue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.REMOVE_USER,
    );

    await ack(NIP29_KIND.REMOVE_USER);
    const row = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: MEMBER,
    });
    expect(row.relay_state).toBe('removed');
  });

  it('unlinked eligible member (null pubkey) is NEVER published, stays pending_add', async () => {
    await seedCreatedRoom();
    await membershipRepo.save(
      membershipRepo.create({
        sale_address: SALE,
        member_address: MEMBER,
        member_pubkey: null as any,
        role: 'member',
        eligible: true,
        relay_state: 'pending_add',
      }),
    );

    await service.onEligibilityChanged({
      saleAddress: SALE,
      memberAddress: MEMBER,
      eligible: true,
    });
    // Also exercised by the scan: the SQL predicate excludes null-pubkey pending_add.
    const scanned = await service.scanAndPublishPending();

    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(scanned).toBe(0);
    const row = await membershipRepo.findOneByOrFail({
      sale_address: SALE,
      member_address: MEMBER,
    });
    expect(row.relay_state).toBe('pending_add');
  });

  it('scan publishes pending members only for created rooms (and skips null-pubkey adds)', async () => {
    await seedCreatedRoom();
    await membershipRepo.save([
      membershipRepo.create({
        sale_address: SALE,
        member_address: 'ak_a',
        member_pubkey: 'b'.repeat(64),
        role: 'member',
        eligible: true,
        relay_state: 'pending_add',
      }),
      membershipRepo.create({
        sale_address: SALE,
        member_address: 'ak_b',
        member_pubkey: null as any,
        role: 'member',
        eligible: true,
        relay_state: 'pending_add',
      }),
      membershipRepo.create({
        sale_address: SALE,
        member_address: 'ak_c',
        member_pubkey: 'c'.repeat(64),
        role: 'member',
        eligible: false,
        relay_state: 'pending_remove',
      }),
    ]);

    const published = await service.scanAndPublishPending();

    // ak_a (9000) + ak_c (9001); ak_b (null pubkey) skipped (§6.6).
    expect(published).toBe(2);
    const kinds = publishQueue.add.mock.calls
      .map((c) => c[0].template.kind)
      .sort();
    expect(kinds).toEqual([NIP29_KIND.PUT_USER, NIP29_KIND.REMOVE_USER].sort());
  });

  it('onRoomCreated drains all pending members of the now-created room', async () => {
    await seedCreatedRoom();
    await membershipRepo.save([
      membershipRepo.create({
        sale_address: SALE,
        member_address: 'ak_a',
        member_pubkey: 'b'.repeat(64),
        eligible: true,
        relay_state: 'pending_add',
      }),
      membershipRepo.create({
        sale_address: SALE,
        member_address: 'ak_b',
        member_pubkey: 'c'.repeat(64),
        eligible: true,
        relay_state: 'pending_add',
      }),
    ]);

    await service.onRoomCreated({ saleAddress: SALE });
    expect(publishQueue.add).toHaveBeenCalledTimes(2);
  });

  it('community delete → exactly one 9008, all rows terminal removed, no resurrection', async () => {
    await seedCreatedRoom();
    await membershipRepo.save([
      membershipRepo.create({
        sale_address: SALE,
        member_address: 'ak_a',
        member_pubkey: 'b'.repeat(64),
        eligible: true,
        relay_state: 'added',
      }),
      membershipRepo.create({
        sale_address: SALE,
        member_address: 'ak_b',
        member_pubkey: 'c'.repeat(64),
        eligible: true,
        relay_state: 'pending_add',
      }),
    ]);
    // Flag the community deleted (Task 04 would do this) before the event.
    await roomRepo.update({ sale_address: SALE }, { deleted: true });

    await service.onCommunityUpserted({ saleAddress: SALE });

    expect(publishQueue.add).toHaveBeenCalledTimes(1);
    expect(publishQueue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.DELETE_GROUP,
    );
    const rows = await membershipRepo.find({ where: { sale_address: SALE } });
    expect(rows.every((r) => r.relay_state === 'removed')).toBe(true);

    // A subsequent add attempt does not resurrect a deleted room.
    publishQueue.add.mockClear();
    await service.onEligibilityChanged({
      saleAddress: SALE,
      memberAddress: 'ak_a',
      eligible: true,
    });
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('burst of N eligibility flips produces ≤ N publishes (no duplicate adds)', async () => {
    await seedCreatedRoom();
    const N = 6;
    for (let i = 0; i < N; i++) {
      await membershipRepo.save(
        membershipRepo.create({
          sale_address: SALE,
          member_address: `ak_burst_${i}`,
          member_pubkey: `${i}`.repeat(64),
          eligible: true,
          relay_state: 'pending_add',
        }),
      );
    }
    const published = await service.scanAndPublishPending();
    expect(published).toBe(N);
    expect(publishQueue.add).toHaveBeenCalledTimes(N);

    // Idempotent re-run: ACK them all, then a second scan enqueues nothing.
    for (let i = 0; i < N; i++) {
      await ack(NIP29_KIND.PUT_USER, `${i}`.repeat(64));
    }
    publishQueue.add.mockClear();
    const again = await service.scanAndPublishPending();
    expect(again).toBe(0);
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  // ── relay-backed section (auto-skips without a reachable groups_relay) ───────
  describe('relay-backed', () => {
    let relayAvailable = false;
    let writer: RelayWriterService;

    beforeAll(async () => {
      relayAvailable =
        !!process.env.TG_RELAY_URL || (await relayReachable(RELAY_URL));
      if (relayAvailable) {
        writer = new RelayWriterService({
          nostrRelayUrl: RELAY_URL,
          nostrBotNsec: RELAY_ADMIN_NSEC,
          publishAckTimeoutMs: 5000,
          publishRatePerSec: 100,
          publishMaxRetries: 5,
          relayHealthPauseSec: 1,
        } as any);
        await writer.onModuleInit();
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[membership-sync.integration] relay section skipped — no relay at ${RELAY_URL}`,
        );
      }
    }, 30_000);

    afterAll(() => {
      writer?.onApplicationShutdown();
    });

    const itRelay = (name: string, fn: () => Promise<void>, timeout = 20000) =>
      it(
        name,
        async () => {
          if (!relayAvailable) {
            return;
          }
          await fn();
        },
        timeout,
      );

    itRelay(
      'enqueued 9000 published to the relay shows in 39002 members; 9001 removes it',
      async () => {
        const { createGroup, editMetadata } = await import('../nostr/nip29');
        const gid = `ct_TgrSync10_${Date.now()}`;
        await writer.publish(createGroup(gid));
        await writer.publish(
          editMetadata(gid, { name: 'SYNC', isPrivate: true }),
        );

        const { generateSecretKey, getPublicKey } = await import('nostr-tools');
        const memberPubkey = getPublicKey(generateSecretKey());

        // Seed a created room for this gid + an eligible pending_add member, then
        // drive the service: it enqueues a 9000 which we publish through the writer
        // (what the processor does), then assert 39002 reflects the member.
        await tokenRepo.save(
          tokenRepo.create({
            sale_address: gid,
            address: 'ct_t_' + gid,
            name: 'SYNC',
            symbol: 'SYNC',
            owner_address: 'ak_o',
            nostr_group_id: gid,
            nostr_room_state: 'created',
            has_nostr_room: true,
          } as Partial<Token>),
        );
        await roomRepo.save(
          roomRepo.create({
            sale_address: gid,
            token_address: 'ct_t_' + gid,
            symbol: 'SYNC',
            owner_address: 'ak_o',
            is_private: true,
            min_token_threshold: new BigNumber('1'),
            moderators: [],
            muted: [],
            is_community: true,
            deleted: false,
          }),
        );
        await membershipRepo.save(
          membershipRepo.create({
            sale_address: gid,
            member_address: 'ak_relay_member',
            member_pubkey: memberPubkey,
            eligible: true,
            relay_state: 'pending_add',
          }),
        );

        await service.onEligibilityChanged({
          saleAddress: gid,
          memberAddress: 'ak_relay_member',
          eligible: true,
        });
        const addJob = publishQueue.add.mock.calls.at(-1)![0];
        expect((await writer.publish(addJob.template)).ok).toBe(true);
        await new Promise((r) => setTimeout(r, 600));

        let members = await writer.fetchGroupMembers(gid);
        expect(members.has(memberPubkey)).toBe(true);

        // Flip eligible=false → 9001 → member gone from 39002.
        await membershipRepo.update(
          { sale_address: gid, member_address: 'ak_relay_member' },
          { eligible: false, relay_state: 'pending_remove' },
        );
        await service.onEligibilityChanged({
          saleAddress: gid,
          memberAddress: 'ak_relay_member',
          eligible: false,
        });
        const removeJob = publishQueue.add.mock.calls.at(-1)![0];
        expect((await writer.publish(removeJob.template)).ok).toBe(true);
        await new Promise((r) => setTimeout(r, 600));

        members = await writer.fetchGroupMembers(gid);
        expect(members.has(memberPubkey)).toBe(false);
      },
    );
  });
});

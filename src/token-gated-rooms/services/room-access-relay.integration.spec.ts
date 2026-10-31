import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { BigNumber } from 'bignumber.js';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { Queue } from 'bull';
import { createIsolatedSchema, IsolatedSchema } from '@/test/harness/db';
import { waitForRelayState } from '@/test/harness/relay';
import { Account } from '@/account/entities/account.entity';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { TokenBalance } from '../entities/token-balance.entity';
import { RelayWriterService } from '../nostr/relay-writer.service';
import { createGroup, editMetadata, putUser } from '../nostr/nip29';
import { PublishNip29Job } from '../queues/publish-nip29.types';
import { BalanceIndexerService } from './balance-indexer.service';
import { EligibilityService } from './eligibility.service';
import { IdentityService } from './identity.service';
import { MembershipSyncService } from './membership-sync.service';
import { RoomsQueryService } from './rooms-query.service';

// Requires an explicitly selected disposable relay and database. Missing inputs
// skip; an opted-in relay that fails to connect must fail the test.
const relayUrl = process.env.TG_TEST_RELAY_URL;
const enabled = !!process.env.DB_HOST && !!relayUrl;
const run = enabled ? describe : describe.skip;

run('balance → eligibility → real relay membership', () => {
  let database: IsolatedSchema;
  let writer: RelayWriterService;
  const config: any = {
    nostrRelayUrl: relayUrl,
    // Public fixture from groups_relay/config/settings.test.yml.
    nostrBotNsec:
      'nsec1dwg3l5mumawgr4xq4kc6klagytkj2w4s4kd2rrthy47g3v5mwx8qwrh7sx',
    nostrLinkProvider: 'nostr',
    publishAckTimeoutMs: 5000,
    publishMaxRetries: 5,
    relayHealthPauseSec: 1,
    reconcileBatchSize: 10,
    communityTokenRefreshSec: 300,
  };

  beforeAll(async () => {
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(relayUrl!).hostname)
    ) {
      throw new Error('This test requires a disposable loopback relay.');
    }
    database = await createIsolatedSchema({
      entities: [Account, Token, CommunityRoom, RoomMembership, TokenBalance],
    });
    writer = new RelayWriterService(config);
    await writer.onModuleInit();
  }, 30_000);

  afterAll(async () => {
    writer?.onApplicationShutdown();
    await database?.drop();
  });

  it('preserves both room rosters when management updates arrive together', async () => {
    const first = `ct_concurrent_${randomUUID()}`;
    const second = `ct_concurrent_${randomUUID()}`;
    const member = getPublicKey(generateSecretKey());
    const created = await Promise.all(
      [first, second].map((room) => writer.publish(createGroup(room))),
    );
    expect(created.every((result) => result.ok)).toBe(true);
    const added = await Promise.all(
      [first, second].map((room) => writer.publish(putUser(room, member))),
    );
    expect(added.every((result) => result.ok)).toBe(true);
    await waitForRelayState(
      () =>
        Promise.all(
          [first, second].map((room) => writer.fetchGroupMembers(room)),
        ),
      (rosters) => rosters.every((members) => members.has(member)),
    );
  }, 15_000);

  it('grants two linked holders only after relay ACK and removes a holder whose balance falls below threshold', async () => {
    const ds = database.dataSource;
    const accounts = ds.getRepository(Account);
    const tokens = ds.getRepository(Token);
    const rooms = ds.getRepository(CommunityRoom);
    const memberships = ds.getRepository(RoomMembership);
    const balances = ds.getRepository(TokenBalance);
    const emitter = new EventEmitter2();
    const identity = new IdentityService(
      accounts,
      memberships,
      config,
      emitter,
    );
    const eligibility = new EligibilityService(
      rooms,
      memberships,
      balances,
      identity,
      emitter,
      config,
    );
    const indexer = new BalanceIndexerService(
      tokens,
      balances,
      emitter,
      config,
    );
    const query = new RoomsQueryService(rooms, memberships, config);
    const pending: PublishNip29Job[] = [];
    const queue = {
      add: jest.fn(async (job: PublishNip29Job) => {
        pending.push(job);
      }),
    };
    const sync = new MembershipSyncService(
      memberships,
      rooms,
      tokens,
      queue as unknown as Queue<PublishNip29Job>,
      { isConfiguredAdmin: () => false } as any,
      emitter,
      new SchedulerRegistry(),
      config,
    );
    const sale = `ct_access_${randomUUID()}`;
    const token = `ct_token_${randomUUID()}`;
    const alice = {
      address: 'ak_access_alice',
      pubkey: getPublicKey(generateSecretKey()),
    };
    const bob = {
      address: 'ak_access_bob',
      pubkey: getPublicKey(generateSecretKey()),
    };

    await accounts.save(
      [alice, bob].map(({ address, pubkey }) => ({
        address,
        links: { nostr: nip19.npubEncode(pubkey) },
      })),
    );
    expect((await writer.publish(createGroup(sale))).ok).toBe(true);
    expect(
      (await writer.publish(editMetadata(sale, { isPrivate: true }))).ok,
    ).toBe(true);
    await tokens.save({
      sale_address: sale,
      address: token,
      name: 'Access test',
      symbol: 'ACCESS',
      nostr_group_id: sale,
      room_id: sale,
      has_nostr_room: true,
      nostr_room_state: 'created',
    });
    const room = await rooms.save({
      sale_address: sale,
      token_address: token,
      symbol: 'ACCESS',
      owner_address: 'ak_owner',
      min_token_threshold: new BigNumber(100),
      is_private: true,
      is_community: true,
      moderators: [],
      muted: [],
    });

    // Drive the same service boundaries as the async event handlers. Queue jobs
    // are captured, signed by the real writer and ACKed only after acceptance.
    const recompute = async (address: string) => {
      await eligibility.recomputeMember(room, address);
      const row = await memberships.findOneBy({
        sale_address: sale,
        member_address: address,
      });
      if (!row) return;
      await sync.onEligibilityChanged({
        saleAddress: sale,
        memberAddress: address,
        eligible: row.eligible,
      });
    };
    const publishPending = async () => {
      for (const job of pending.splice(0)) {
        const result = await writer.publish(job.template);
        expect(result.ok).toBe(true);
        await sync.onPublishAck({
          saleAddress: sale,
          kind: job.template.kind,
          ok: result.ok,
          pubkey: job.template.tags.find((tag) => tag[0] === 'p')?.[1],
        });
      }
    };

    await indexer.applyDelta(token, alice.address, new BigNumber(100), 1);
    await recompute(alice.address);
    await recompute(bob.address);
    expect(
      (await query.listEligibleRooms(alice.address, 1, 10)).items[0].readable,
    ).toBe(false);
    expect((await query.listEligibleRooms(bob.address, 1, 10)).items).toEqual(
      [],
    );
    await publishPending();
    await waitForRelayState(
      () => writer.fetchGroupMembers(sale),
      (members) => members.has(alice.pubkey),
    );
    expect(
      (await query.listEligibleRooms(alice.address, 1, 10)).items[0].readable,
    ).toBe(true);

    await indexer.applyDelta(token, bob.address, new BigNumber(100), 2);
    await recompute(bob.address);
    await publishPending();
    const both = await waitForRelayState(
      () => writer.fetchGroupMembers(sale),
      (members) => members.has(bob.pubkey),
    );
    expect(both.has(alice.pubkey)).toBe(true);
    expect(both.has(bob.pubkey)).toBe(true);
    expect(
      (await query.listEligibleRooms(bob.address, 1, 10)).items[0].readable,
    ).toBe(true);

    await indexer.applyDelta(token, bob.address, new BigNumber(-1), 3);
    await recompute(bob.address);
    expect((await query.listEligibleRooms(bob.address, 1, 10)).items).toEqual(
      [],
    );
    await publishPending();
    const remaining = await waitForRelayState(
      () => writer.fetchGroupMembers(sale),
      (members) => !members.has(bob.pubkey),
    );
    expect(remaining.has(alice.pubkey)).toBe(true);
    expect(remaining.has(bob.pubkey)).toBe(false);
    expect(
      (
        await memberships.findOneByOrFail({
          sale_address: sale,
          member_address: bob.address,
        })
      ).relay_state,
    ).toBe('removed');
  }, 45_000);
});

import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { Queue } from 'bull';
import {
  MEMBERSHIP_SYNC_SCAN_JOB,
  MembershipSyncService,
  roomConfirmedCreated,
} from './membership-sync.service';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { Token } from '@/tokens/entities/token.entity';
import { RoomAdminsService } from './room-admins.service';
import { NIP29_KIND } from '../nostr/nip29';
import {
  TGR_MEMBERSHIP_CHANGED,
  type TgrMembershipChangedPayload,
} from '../events';

const SALE = 'ct_sale';
const GROUP = SALE;
const PUBKEY = 'a'.repeat(64);

function makeRoom(over: Partial<CommunityRoom> = {}): CommunityRoom {
  return {
    sale_address: SALE,
    token_address: 'ct_token',
    symbol: 'TGR',
    owner_address: 'ak_owner',
    is_private: false,
    min_token_threshold: undefined as any,
    moderators: [],
    muted: [],
    is_community: true,
    state_synced_at: new Date(),
    created_height: 1,
    deleted: false,
    ...over,
  } as CommunityRoom;
}

function makeMembership(over: Partial<RoomMembership> = {}): RoomMembership {
  return {
    id: 1,
    sale_address: SALE,
    member_address: 'ak_member',
    member_pubkey: PUBKEY,
    role: 'member',
    eligible: true,
    relay_state: 'pending_add',
    held_until_height: null as any,
    last_published_at: null as any,
    last_reconciled_at: null as any,
    updated_at: new Date(),
    ...over,
  } as RoomMembership;
}

function makeToken(over: Partial<Token> = {}): Token {
  return {
    sale_address: SALE,
    nostr_group_id: null,
    nostr_room_state: 'created',
    ...over,
  } as unknown as Token;
}

interface Harness {
  service: MembershipSyncService;
  membershipRepo: jest.Mocked<Repository<RoomMembership>>;
  communityRoomRepo: jest.Mocked<Repository<CommunityRoom>>;
  tokenRepo: jest.Mocked<Repository<Token>>;
  queue: { add: jest.Mock };
  roomAdmins: { isConfiguredAdmin: jest.Mock };
  emitter: EventEmitter2;
  emitted: TgrMembershipChangedPayload[];
  scheduler: {
    addInterval: jest.Mock;
    deleteInterval: jest.Mock;
    doesExist: jest.Mock;
  };
}

function setup(
  opts: {
    room?: CommunityRoom | null;
    token?: Token | null;
    membership?: RoomMembership | null;
    isConfiguredAdmin?: boolean;
    /**
     * When true, the injected tgrConfig carries a relay url + bot nsec, so
     * `isRelayConfigured(this.config)` is true and the relay-actuator duties
     * (the periodic membership-sync scan interval) self-enable. Left false
     * (default) the config has no relay credentials → the service stays dormant.
     */
    relayConfigured?: boolean;
  } = {},
): Harness {
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const membershipRepo = {
    findOne: jest.fn().mockResolvedValue(opts.membership ?? null),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(),
  } as unknown as jest.Mocked<Repository<RoomMembership>>;
  const communityRoomRepo = {
    findOne: jest.fn().mockResolvedValue(opts.room ?? null),
  } as unknown as jest.Mocked<Repository<CommunityRoom>>;
  const tokenRepo = {
    findOne: jest.fn().mockResolvedValue(opts.token ?? makeToken()),
  } as unknown as jest.Mocked<Repository<Token>>;
  const roomAdmins = {
    isConfiguredAdmin: jest
      .fn()
      .mockReturnValue(opts.isConfiguredAdmin ?? false),
  };
  const emitter = new EventEmitter2();
  const emitted: TgrMembershipChangedPayload[] = [];
  emitter.on(TGR_MEMBERSHIP_CHANGED, (p: TgrMembershipChangedPayload) =>
    emitted.push(p),
  );
  const scheduler = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(false),
  };

  const service = new MembershipSyncService(
    membershipRepo,
    communityRoomRepo,
    tokenRepo,
    queue as unknown as Queue,
    roomAdmins as unknown as RoomAdminsService,
    emitter,
    scheduler as unknown as SchedulerRegistry,
    {
      // Relay creds gate the relay-actuator duties via `isRelayConfigured`
      // (worker mode removed — see deworker-plan.md). Set only when the test
      // wants the membership-sync scan interval to self-enable.
      nostrRelayUrl: opts.relayConfigured ? 'ws://relay' : undefined,
      nostrBotNsec: opts.relayConfigured ? 'nsec1abc' : undefined,
      publishMaxRetries: 5,
      reconcileBatchSize: 500,
      reconcileIntervalSec: 600,
    } as any,
  );

  return {
    service,
    membershipRepo,
    communityRoomRepo,
    tokenRepo,
    queue,
    roomAdmins,
    emitter,
    emitted,
    scheduler,
  };
}

/** Build a chainable query-builder mock returning `pages` in sequence. */
function queryBuilderReturning(pages: RoomMembership[][]) {
  let call = 0;
  const qb: any = {
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    limit: jest.fn(() => qb),
    getMany: jest.fn(async () => pages[call++] ?? []),
  };
  return qb;
}

describe('MembershipSyncService — desired→publish mapping', () => {
  it('pending_add (+pubkey, not muted, not deleted) → one 9000 putUser with correct group/p tag', async () => {
    const row = makeMembership({ relay_state: 'pending_add', role: 'member' });
    const h = setup({ room: makeRoom(), membership: row });

    const enqueued = await h.service.publishForRow(row);

    expect(enqueued).toBe(true);
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    const job = h.queue.add.mock.calls[0][0];
    expect(job.template.kind).toBe(NIP29_KIND.PUT_USER);
    expect(job.groupId).toBe(GROUP);
    expect(job.template.tags[0]).toEqual(['h', GROUP]);
    expect(job.template.tags[1]).toEqual(['p', PUBKEY]); // plain member add
  });

  it('pending_add with admin role → 9000 ["p", pubkey, "admin"]', async () => {
    const row = makeMembership({ relay_state: 'pending_add', role: 'admin' });
    const h = setup({ room: makeRoom(), membership: row });

    await h.service.publishForRow(row);

    const job = h.queue.add.mock.calls[0][0];
    expect(job.template.kind).toBe(NIP29_KIND.PUT_USER);
    expect(job.template.tags[1]).toEqual(['p', PUBKEY, 'admin']);
  });

  it('pending_remove (+pubkey, not configured admin) → one 9001 removeUser', async () => {
    const row = makeMembership({ relay_state: 'pending_remove' });
    const h = setup({ room: makeRoom(), membership: row });

    const enqueued = await h.service.publishForRow(row);

    expect(enqueued).toBe(true);
    const job = h.queue.add.mock.calls[0][0];
    expect(job.template.kind).toBe(NIP29_KIND.REMOVE_USER);
    expect(job.groupId).toBe(GROUP);
    expect(job.template.tags[1]).toEqual(['p', PUBKEY]);
  });
});

describe('MembershipSyncService — skip unlinked (§6.6)', () => {
  it('pending_add with member_pubkey=null → no enqueue, no event, stays pending_add', async () => {
    const row = makeMembership({
      relay_state: 'pending_add',
      member_pubkey: null as any,
    });
    const h = setup({ room: makeRoom(), membership: row });

    const enqueued = await h.service.publishForRow(row);

    expect(enqueued).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.membershipRepo.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });
});

describe('MembershipSyncService — mute (§5.1, never re-add)', () => {
  it('stale pending_add for a muted member enqueues NO 9000', async () => {
    const row = makeMembership({ relay_state: 'pending_add' });
    const h = setup({
      room: makeRoom({ muted: ['ak_member'] }),
      membership: row,
    });

    const enqueued = await h.service.publishForRow(row);

    expect(enqueued).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('muted member desired-removed → 9001 still enqueues', async () => {
    const row = makeMembership({ relay_state: 'pending_remove' });
    const h = setup({
      room: makeRoom({ muted: ['ak_member'] }),
      membership: row,
    });

    const enqueued = await h.service.publishForRow(row);

    expect(enqueued).toBe(true);
    expect(h.queue.add.mock.calls[0][0].template.kind).toBe(
      NIP29_KIND.REMOVE_USER,
    );
  });
});

describe('MembershipSyncService — admin exemption (§6.7)', () => {
  it('pending_remove whose pubkey isConfiguredAdmin → no 9001 enqueued', async () => {
    const row = makeMembership({ relay_state: 'pending_remove' });
    const h = setup({
      room: makeRoom(),
      membership: row,
      isConfiguredAdmin: true,
    });

    const enqueued = await h.service.publishForRow(row);

    expect(enqueued).toBe(false);
    expect(h.roomAdmins.isConfiguredAdmin).toHaveBeenCalledWith(PUBKEY);
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe('MembershipSyncService — role transitions (§6.7)', () => {
  it('member → admin promotion → 9006 setRoles(["admin"])', async () => {
    const row = makeMembership({ relay_state: 'added', role: 'admin' });
    const h = setup({ room: makeRoom(), membership: row });

    const enqueued = await h.service.publishRoleChange(SALE, 'ak_member');

    expect(enqueued).toBe(true);
    const job = h.queue.add.mock.calls[0][0];
    expect(job.template.kind).toBe(NIP29_KIND.SET_ROLES);
    expect(job.template.tags[1]).toEqual(['p', PUBKEY, 'admin']);
  });

  it('admin → member demotion → 9006 setRoles(["member"]), never a 9000 downgrade', async () => {
    const row = makeMembership({ relay_state: 'added', role: 'member' });
    const h = setup({ room: makeRoom(), membership: row });

    const enqueued = await h.service.publishRoleChange(SALE, 'ak_member');

    expect(enqueued).toBe(true);
    const job = h.queue.add.mock.calls[0][0];
    expect(job.template.kind).toBe(NIP29_KIND.SET_ROLES);
    expect(job.template.kind).not.toBe(NIP29_KIND.PUT_USER);
    expect(job.template.tags[1]).toEqual(['p', PUBKEY, 'member']);
  });

  it('demotion of a configured admin is refused (last-admin guard)', async () => {
    const row = makeMembership({ relay_state: 'added', role: 'member' });
    const h = setup({
      room: makeRoom(),
      membership: row,
      isConfiguredAdmin: true,
    });

    const enqueued = await h.service.publishRoleChange(SALE, 'ak_member');

    expect(enqueued).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('role change for a not-yet-added member is a no-op', async () => {
    const row = makeMembership({ relay_state: 'pending_add', role: 'admin' });
    const h = setup({ room: makeRoom(), membership: row });

    const enqueued = await h.service.publishRoleChange(SALE, 'ak_member');

    expect(enqueued).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe('MembershipSyncService — ACK-driven relay_state flips (§6.3)', () => {
  it('9000 ACK → relay_state="added" + last_published_at + emits added', async () => {
    const row = makeMembership({ relay_state: 'pending_add' });
    const h = setup({ membership: row });

    await h.service.onPublishAck({
      saleAddress: SALE,
      pubkey: PUBKEY,
      kind: NIP29_KIND.PUT_USER,
      ok: true,
    });

    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: row.id },
      expect.objectContaining({
        relay_state: 'added',
        last_published_at: expect.any(Date),
      }),
    );
    expect(h.emitted).toEqual([
      { saleAddress: SALE, memberAddress: 'ak_member', relayState: 'added' },
    ]);
  });

  it('9001 ACK → relay_state="removed" + emits removed', async () => {
    const row = makeMembership({ relay_state: 'pending_remove' });
    const h = setup({ membership: row });

    await h.service.onPublishAck({
      saleAddress: SALE,
      pubkey: PUBKEY,
      kind: NIP29_KIND.REMOVE_USER,
      ok: true,
    });

    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: row.id },
      expect.objectContaining({ relay_state: 'removed' }),
    );
    expect(h.emitted).toEqual([
      { saleAddress: SALE, memberAddress: 'ak_member', relayState: 'removed' },
    ]);
  });

  it('re-observed 9000 ACK on an already-added row is a no-op (no write, no event)', async () => {
    const row = makeMembership({ relay_state: 'added' });
    const h = setup({ membership: row });

    await h.service.onPublishAck({
      saleAddress: SALE,
      pubkey: PUBKEY,
      kind: NIP29_KIND.PUT_USER,
      ok: true,
    });

    expect(h.membershipRepo.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('re-observed 9001 ACK on an already-removed row is a no-op', async () => {
    const row = makeMembership({ relay_state: 'removed' });
    const h = setup({ membership: row });

    await h.service.onPublishAck({
      saleAddress: SALE,
      pubkey: PUBKEY,
      kind: NIP29_KIND.REMOVE_USER,
      ok: true,
    });

    expect(h.membershipRepo.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('failed ACK (ok=false) leaves pending state untouched', async () => {
    const row = makeMembership({ relay_state: 'pending_add' });
    const h = setup({ membership: row });

    await h.service.onPublishAck({
      saleAddress: SALE,
      pubkey: PUBKEY,
      kind: NIP29_KIND.PUT_USER,
      ok: false,
    });

    expect(h.membershipRepo.findOne).not.toHaveBeenCalled();
    expect(h.membershipRepo.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('group-level ACK (no pubkey) is ignored (Task 09 concern)', async () => {
    const h = setup();
    await h.service.onPublishAck({
      saleAddress: SALE,
      kind: NIP29_KIND.CREATE_GROUP,
      ok: true,
    });
    expect(h.membershipRepo.findOne).not.toHaveBeenCalled();
    expect(h.membershipRepo.update).not.toHaveBeenCalled();
  });
});

describe('MembershipSyncService — community deletion → 9008 (§4.7, terminal)', () => {
  it('deleted room → exactly one 9008 deleteGroup, no per-member 9001, all rows removed', async () => {
    const rowA = makeMembership({ id: 1, relay_state: 'added' });
    const rowB = makeMembership({
      id: 2,
      member_address: 'ak_other',
      relay_state: 'pending_add',
    });
    const h = setup({ room: makeRoom({ deleted: true }) });
    h.membershipRepo.find = jest.fn().mockResolvedValue([rowA, rowB]);

    await h.service.onCommunityUpserted({ saleAddress: SALE });

    // exactly one 9008, no 9001/9000
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    const job = h.queue.add.mock.calls[0][0];
    expect(job.template.kind).toBe(NIP29_KIND.DELETE_GROUP);
    expect(job.template.tags).toEqual([['h', GROUP]]);

    // both rows set terminal removed
    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({ relay_state: 'removed' }),
    );
    expect(h.membershipRepo.update).toHaveBeenCalledWith(
      { id: 2 },
      expect.objectContaining({ relay_state: 'removed' }),
    );
    expect(h.emitted.map((e) => e.relayState)).toEqual(['removed', 'removed']);
  });

  it('non-deleted community upsert → no delete-group enqueued', async () => {
    const h = setup({ room: makeRoom({ deleted: false }) });
    await h.service.onCommunityUpserted({ saleAddress: SALE });
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('publishForRow on a deleted room never (re)publishes members', async () => {
    const row = makeMembership({ relay_state: 'pending_add' });
    const h = setup({ room: makeRoom({ deleted: true }), membership: row });

    const enqueued = await h.service.publishForRow(row);

    expect(enqueued).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe('MembershipSyncService — idempotency (Req 10)', () => {
  it('re-delivered unchanged tgr.eligibility.changed for an added row enqueues + emits nothing', async () => {
    const row = makeMembership({ relay_state: 'added' });
    const h = setup({ room: makeRoom(), membership: row });

    await h.service.onEligibilityChanged({
      saleAddress: SALE,
      memberAddress: 'ak_member',
      eligible: true,
    });

    expect(h.queue.add).not.toHaveBeenCalled();
    expect(h.membershipRepo.update).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  it('onEligibilityChanged with no row → no-op', async () => {
    const h = setup({ membership: null });
    await h.service.onEligibilityChanged({
      saleAddress: SALE,
      memberAddress: 'ak_member',
      eligible: true,
    });
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe('MembershipSyncService — scan predicate + idempotency', () => {
  it('scan selects only created rooms; pending_add(+pubkey)→9000, pending_remove→9001', async () => {
    const add = makeMembership({ id: 1, relay_state: 'pending_add' });
    const remove = makeMembership({
      id: 2,
      member_address: 'ak_other',
      member_pubkey: 'b'.repeat(64),
      relay_state: 'pending_remove',
    });
    const h = setup({ room: makeRoom(), token: makeToken() });
    h.membershipRepo.createQueryBuilder = jest
      .fn()
      .mockReturnValue(queryBuilderReturning([[add, remove]]));

    const published = await h.service.scanAndPublishPending();

    expect(published).toBe(2);
    const kinds = h.queue.add.mock.calls.map((c) => c[0].template.kind);
    expect(kinds).toEqual([NIP29_KIND.PUT_USER, NIP29_KIND.REMOVE_USER]);
  });

  it('scan skips rooms whose token nostr_room_state != created', async () => {
    const add = makeMembership({ id: 1, relay_state: 'pending_add' });
    const h = setup({
      room: makeRoom(),
      token: makeToken({ nostr_room_state: 'pending' } as any),
    });
    h.membershipRepo.createQueryBuilder = jest
      .fn()
      .mockReturnValue(queryBuilderReturning([[add]]));

    const published = await h.service.scanAndPublishPending();

    expect(published).toBe(0);
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('scan: a burst of N pending_add rows produces ≤ N publishes (no duplicate adds)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeMembership({
        id: i + 1,
        member_address: `ak_${i}`,
        member_pubkey: `${i}`.repeat(64),
        relay_state: 'pending_add',
      }),
    );
    const h = setup({ room: makeRoom(), token: makeToken() });
    h.membershipRepo.createQueryBuilder = jest
      .fn()
      .mockReturnValue(queryBuilderReturning([rows]));

    const published = await h.service.scanAndPublishPending();

    expect(published).toBe(5);
    expect(h.queue.add).toHaveBeenCalledTimes(5);
  });
});

describe('MembershipSyncService — onModuleInit relay gate', () => {
  it('relay NOT configured → does NOT register the periodic scan interval', () => {
    const h = setup(); // no relay creds on the injected config → dormant
    h.service.onModuleInit();
    expect(h.scheduler.addInterval).not.toHaveBeenCalled();
  });

  it('relay configured → registers the periodic scan interval and tears it down', () => {
    const h = setup({ relayConfigured: true });
    h.service.onModuleInit();
    expect(h.scheduler.addInterval).toHaveBeenCalledTimes(1);
    expect(h.scheduler.addInterval.mock.calls[0][0]).toBe(
      MEMBERSHIP_SYNC_SCAN_JOB,
    );

    h.scheduler.doesExist.mockReturnValue(true);
    h.service.onApplicationShutdown();
    expect(h.scheduler.deleteInterval).toHaveBeenCalledWith(
      MEMBERSHIP_SYNC_SCAN_JOB,
    );
    // Stop the live timer created by setInterval (unref'd, but clean up anyway).
    clearInterval(h.scheduler.addInterval.mock.calls[0][1] as NodeJS.Timeout);
  });
});

describe('roomConfirmedCreated (room_id is the durable created-marker)', () => {
  it('true when nostr_room_state === "created"', () => {
    expect(roomConfirmedCreated({ nostr_room_state: 'created' })).toBe(true);
  });

  it('true when room_id is set even if nostr_room_state was reset to "none"', () => {
    // The exact desync we observed: the 9007 ACK stamped room_id (group exists on
    // the relay), but a re-index / schema synchronize reset nostr_room_state back
    // to the default. The member must still be publishable.
    expect(
      roomConfirmedCreated({ nostr_room_state: 'none', room_id: 'ct_abc' }),
    ).toBe(true);
  });

  it('false when neither signal is present (room not created yet)', () => {
    expect(
      roomConfirmedCreated({ nostr_room_state: 'none', room_id: null }),
    ).toBe(false);
    expect(roomConfirmedCreated({ nostr_room_state: 'pending' })).toBe(false);
    expect(roomConfirmedCreated(null)).toBe(false);
  });
});

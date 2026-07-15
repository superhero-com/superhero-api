import { EventEmitter2 } from '@nestjs/event-emitter';
import type { JobOptions, Queue } from 'bull';
import { BigNumber } from 'bignumber.js';
import type { Token } from '@/tokens/entities/token.entity';
import { NIP29_KIND } from '../nostr/nip29';
import { TGR_ROOM_CREATED } from '../events';
import type { NostrRoomState } from '../enums/nostr-room-state.enum';
import { TGR_CAPPED_BACKOFF } from '../queues/publish-nip29.job-options';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import { nextStateForAck, RoomBackfillService } from './room-backfill.service';
import { GroupMissingTracker } from './group-missing-tracker.service';

/**
 * Unit coverage for the eager room backfill (Task 09):
 *  - the `nostr_room_state` machine (every Req 3 transition), driven by the
 *    `tgr.publish.ack` seam + the pure {@link nextStateForAck} decision;
 *  - the batch cursor: deterministic `sale_address` ordering, page-size honors
 *    `backfillBatchSize`, the `has_nostr_room=false AND state NOT IN
 *    (created,deleted)` predicate, and cursor advance;
 *  - private-flag derivation for `9002` (private when `community_room.is_private`,
 *    public when the row is absent);
 *  - admin seeding is DELEGATED to the Task 08 helper (invoked once per room).
 *
 * All collaborators are mocked — no DB, no relay. Boot-safety (no auto-run) is
 * asserted via `onApplicationBootstrap` with the flag unset.
 */
describe('RoomBackfillService (unit)', () => {
  const SALE = 'ct_tgr09_sale_1';

  type Mocks = {
    service: RoomBackfillService;
    tokenRepo: any;
    communityRoomRepo: any;
    backfillStateRepo: any;
    publishQueue: jest.Mocked<Pick<Queue, 'add'>>;
    backfillQueue: jest.Mocked<Pick<Queue, 'add'>>;
    roomAdmins: { seedRoomAdmins: jest.Mock };
    emitter: EventEmitter2;
    groupMissing: GroupMissingTracker;
    update: jest.Mock;
  };

  const makeToken = (overrides: Partial<Token> = {}): Token =>
    ({
      sale_address: SALE,
      symbol: 'TG',
      has_nostr_room: false,
      nostr_room_state: 'none',
      ...overrides,
    }) as Token;

  const build = (
    opts: {
      page?: Token[];
      findToken?: Token | null;
      isPrivateRow?: { is_private: boolean } | null;
      batchSize?: number;
      /**
       * When true, the injected tgrConfig carries a relay URL + bot nsec so
       * `isRelayConfigured(this.config)` is satisfied — this is the new switch
       * that arms the relay-actuator duties (eager boot backfill, the reactive
       * `onCommunityUpserted` create). Default false keeps the service dormant.
       */
      relayConfigured?: boolean;
    } = {},
  ): Mocks => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });

    // Query builder used by workingSetPage / pendingCount.
    const qb: any = {
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      limit: jest.fn(() => qb),
      getMany: jest.fn(async () => opts.page ?? []),
      getCount: jest.fn(async () => (opts.page ?? []).length),
    };

    const tokenRepo: any = {
      createQueryBuilder: jest.fn(() => qb),
      update,
      findOne: jest.fn(async () =>
        opts.findToken === undefined ? null : opts.findToken,
      ),
      find: jest.fn(async () => opts.page ?? []),
    };
    const communityRoomRepo: any = {
      findOne: jest.fn(async () =>
        opts.isPrivateRow === undefined ? null : opts.isPrivateRow,
      ),
    };
    const backfillStateRepo: any = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(async () => ({ batch_offset: 0 })),
    };
    const publishQueue = {
      add: jest.fn().mockResolvedValue({ id: 'pub1' }),
    } as any;
    const backfillQueue = {
      add: jest.fn().mockResolvedValue({ id: 'bf1' }),
    } as any;
    const roomAdmins = { seedRoomAdmins: jest.fn().mockResolvedValue(1) };
    const emitter = new EventEmitter2();
    const config: any = {
      backfillBatchSize: opts.batchSize ?? 200,
      publishMaxRetries: 5,
      // Relay-enable switch (DW2): both present + non-blank ⟺
      // `isRelayConfigured(this.config)` is true. Unset → dormant.
      nostrRelayUrl: opts.relayConfigured ? 'ws://relay.test' : undefined,
      nostrBotNsec: opts.relayConfigured ? 'nsec1abc' : undefined,
    };

    const groupMissing = new GroupMissingTracker();

    const service = new RoomBackfillService(
      tokenRepo,
      communityRoomRepo,
      backfillStateRepo,
      publishQueue,
      backfillQueue,
      roomAdmins as any,
      emitter,
      config,
      groupMissing,
    );

    return {
      service,
      tokenRepo,
      communityRoomRepo,
      backfillStateRepo,
      publishQueue,
      backfillQueue,
      roomAdmins,
      emitter,
      groupMissing,
      update,
    };
  };

  /** Read the n-th publishQueue.add as (job, opts). */
  const pub = (
    q: jest.Mocked<Pick<Queue, 'add'>>,
    n = 0,
  ): [PublishNip29Job, JobOptions] =>
    q.add.mock.calls[n] as unknown as [PublishNip29Job, JobOptions];

  // ── pure transition decision ────────────────────────────────────────────────
  describe('nextStateForAck (state machine, §4.7)', () => {
    it('none/failed → created on a 9007 ok ACK', () => {
      expect(nextStateForAck('pending', NIP29_KIND.CREATE_GROUP, true)).toBe(
        'created',
      );
    });

    it('"Group already exists" surfaces as a 9007 ok → created', () => {
      // The processor maps already-exists to ok:true, so it reaches us as ok.
      expect(nextStateForAck('pending', NIP29_KIND.CREATE_GROUP, true)).toBe(
        'created',
      );
    });

    it('pending → failed on a 9007 failure ACK (retries exhausted)', () => {
      expect(nextStateForAck('pending', NIP29_KIND.CREATE_GROUP, false)).toBe(
        'failed',
      );
    });

    it('pending → failed on a 9002 failure ACK', () => {
      expect(nextStateForAck('pending', NIP29_KIND.EDIT_METADATA, false)).toBe(
        'failed',
      );
    });

    it('9002 ok ACK is non-authoritative for existence → no change', () => {
      expect(
        nextStateForAck('pending', NIP29_KIND.EDIT_METADATA, true),
      ).toBeUndefined();
    });

    it('created never regresses on a re-publish ACK (idempotent re-run)', () => {
      expect(
        nextStateForAck('created', NIP29_KIND.CREATE_GROUP, true),
      ).toBeUndefined();
      expect(
        nextStateForAck('created', NIP29_KIND.CREATE_GROUP, false),
      ).toBeUndefined();
    });

    it('deleted is terminal — no ACK moves it', () => {
      expect(
        nextStateForAck('deleted', NIP29_KIND.CREATE_GROUP, true),
      ).toBeUndefined();
      expect(
        nextStateForAck('deleted', NIP29_KIND.EDIT_METADATA, false),
      ).toBeUndefined();
    });
  });

  // ── requestRoom: none → pending + publish sequence ──────────────────────────
  describe('requestRoom (none → pending; publish sequence)', () => {
    it('transitions none → pending, stamps group id, enqueues 9007 then 9002, seeds admins', async () => {
      const m = build({ isPrivateRow: null });
      const token = makeToken({ nostr_room_state: 'none' });

      const result = await m.service.requestRoom(token);

      expect(result.requested).toBe(true);
      expect(result.state).toBe('pending');

      // none → pending with group id stamped (conditional on the from-state).
      expect(m.update).toHaveBeenCalledWith(
        { sale_address: SALE, nostr_room_state: 'none' },
        { nostr_room_state: 'pending', nostr_group_id: SALE },
      );

      // Two group-level publishes in order: 9007 then 9002.
      expect(m.publishQueue.add).toHaveBeenCalledTimes(2);
      const [createJob, createOpts] = pub(m.publishQueue, 0);
      expect(createJob.template.kind).toBe(NIP29_KIND.CREATE_GROUP);
      expect(createJob.template.tags[0]).toEqual(['h', SALE]);
      expect(createJob.groupId).toBe(SALE);
      expect(createJob.meta?.saleAddress).toBe(SALE);
      // §18 retry/backoff contract spread.
      expect(createOpts.attempts).toBe(6);
      expect(createOpts.backoff).toEqual({ type: TGR_CAPPED_BACKOFF });

      const [editJob] = pub(m.publishQueue, 1);
      expect(editJob.template.kind).toBe(NIP29_KIND.EDIT_METADATA);
      const tagKeys = editJob.template.tags.map((t) => t[0]);
      expect(tagKeys).toContain('name');
      expect(tagKeys).toContain('public');
      expect(tagKeys).toContain('closed');

      // Admin seeding delegated to Task 08 (NOT reimplemented), once per room.
      expect(m.roomAdmins.seedRoomAdmins).toHaveBeenCalledTimes(1);
      expect(m.roomAdmins.seedRoomAdmins).toHaveBeenCalledWith(SALE);
    });

    it('retries a failed token: failed → pending', async () => {
      const m = build({ isPrivateRow: null });
      const token = makeToken({ nostr_room_state: 'failed' });

      const result = await m.service.requestRoom(token);

      expect(result.state).toBe('pending');
      expect(m.update).toHaveBeenCalledWith(
        { sale_address: SALE, nostr_room_state: 'failed' },
        { nostr_room_state: 'pending', nostr_group_id: SALE },
      );
    });

    it('re-publishes a pending token in place (no state change)', async () => {
      const m = build({ isPrivateRow: null });
      const token = makeToken({ nostr_room_state: 'pending' });

      const result = await m.service.requestRoom(token);

      expect(result.requested).toBe(true);
      expect(result.state).toBe('pending');
      // No transition update for an already-pending row …
      expect(m.update).not.toHaveBeenCalled();
      // … but the publishes are re-enqueued (relay collapses them).
      expect(m.publishQueue.add).toHaveBeenCalledTimes(2);
    });

    it('skips a created token — terminal/done, never re-enqueues', async () => {
      const m = build();
      const token = makeToken({
        nostr_room_state: 'created',
        has_nostr_room: true,
      });
      const result = await m.service.requestRoom(token);
      expect(result.requested).toBe(false);
      expect(result.state).toBe('created');
      expect(m.publishQueue.add).not.toHaveBeenCalled();
      expect(m.roomAdmins.seedRoomAdmins).not.toHaveBeenCalled();
    });

    it('skips a deleted token (9008 terminal) — never re-enqueues', async () => {
      const m = build();
      const token = makeToken({ nostr_room_state: 'deleted' });
      const result = await m.service.requestRoom(token);
      expect(result.requested).toBe(false);
      expect(result.state).toBe('deleted');
      expect(m.publishQueue.add).not.toHaveBeenCalled();
    });
  });

  // ── private flag derivation (§Req 2.2) ──────────────────────────────────────
  describe('private flag on 9002', () => {
    it('private when community_room.is_private = true', async () => {
      const m = build({ isPrivateRow: { is_private: true } });
      await m.service.requestRoom(makeToken());
      const [editJob] = pub(m.publishQueue, 1);
      const tagKeys = editJob.template.tags.map((t) => t[0]);
      expect(tagKeys).toContain('private');
      expect(tagKeys).not.toContain('public');
    });

    it('public when no community_room row exists (plain [TG] token, D8)', async () => {
      const m = build({ isPrivateRow: null });
      await m.service.requestRoom(makeToken());
      const [editJob] = pub(m.publishQueue, 1);
      const tagKeys = editJob.template.tags.map((t) => t[0]);
      expect(tagKeys).toContain('public');
      expect(tagKeys).not.toContain('private');
    });
  });

  // ── batch cursor / working-set predicate (§Req 1, §5) ───────────────────────
  describe('processPage (batch cursor)', () => {
    it('selects with the predicate, deterministic sale_address order, page-size = batchSize', async () => {
      const m = build({
        page: [makeToken({ sale_address: 'ct_a' })],
        batchSize: 50,
        isPrivateRow: null,
      });

      await m.service.processPage();

      const qb = m.tokenRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('token.has_nostr_room = :flag', {
        flag: false,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'token.nostr_room_state NOT IN (:...done)',
        { done: ['created', 'deleted'] },
      );
      expect(qb.orderBy).toHaveBeenCalledWith('token.sale_address', 'ASC');
      expect(qb.limit).toHaveBeenCalledWith(50);
    });

    it('reports hasMore + the keyset cursor (last sale_address) when the page is full, and advances the count', async () => {
      const page = [
        makeToken({ sale_address: 'ct_a' }),
        makeToken({ sale_address: 'ct_b' }),
      ];
      const m = build({ page, batchSize: 2, isPrivateRow: null });
      m.backfillStateRepo.findOne.mockResolvedValue({ batch_offset: 0 });

      const result = await m.service.processPage();

      expect(result.requested).toBe(2);
      expect(result.hasMore).toBe(true); // page filled the batch size
      expect(result.nextCursor).toBe('ct_b'); // keyset cursor = last sale_address
      // cumulative requested count persisted for observability
      expect(m.backfillStateRepo.upsert).toHaveBeenCalledWith(
        { id: 'global', batch_offset: 2 },
        { conflictPaths: ['id'] },
      );
    });

    it('keyset-pages after the supplied cursor', async () => {
      const m = build({
        page: [makeToken({ sale_address: 'ct_z' })],
        batchSize: 2,
        isPrivateRow: null,
      });
      await m.service.processPage('ct_m');
      const qb = m.tokenRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.andWhere).toHaveBeenCalledWith('token.sale_address > :after', {
        after: 'ct_m',
      });
    });

    it('reports !hasMore on a short final page', async () => {
      const m = build({
        page: [makeToken({ sale_address: 'ct_a' })],
        batchSize: 200,
        isPrivateRow: null,
      });
      const result = await m.service.processPage();
      expect(result.hasMore).toBe(false);
    });

    it('isolates a per-token failure: the page continues', async () => {
      const page = [
        makeToken({ sale_address: 'ct_a' }),
        makeToken({ sale_address: 'ct_b' }),
      ];
      const m = build({ page, batchSize: 5, isPrivateRow: null });
      // First requestRoom throws (e.g. transient publish enqueue error).
      const spy = jest
        .spyOn(m.service, 'requestRoom')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({
          saleAddress: 'ct_b',
          requested: true,
          state: 'pending' as NostrRoomState,
        });

      const result = await m.service.processPage();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(result.requested).toBe(1); // only ct_b counted
    });
  });

  // ── ACK-driven transitions (§Req 3) ─────────────────────────────────────────
  describe('onPublishAck (drive state on the ack seam)', () => {
    it('9007 ok → created: sets has_nostr_room + created_at, emits tgr.room.created', async () => {
      const m = build({
        findToken: makeToken({ nostr_room_state: 'pending' }),
      });
      const created: string[] = [];
      m.emitter.on(TGR_ROOM_CREATED, (p: { saleAddress: string }) =>
        created.push(p.saleAddress),
      );

      await m.service.onPublishAck({
        saleAddress: SALE,
        kind: NIP29_KIND.CREATE_GROUP,
        ok: true,
      });

      expect(m.update).toHaveBeenCalledWith(
        { sale_address: SALE, nostr_room_state: 'pending' },
        expect.objectContaining({
          nostr_room_state: 'created',
          has_nostr_room: true,
          nostr_room_created_at: expect.any(Date),
          // room_id is the confirmed-created marker (= the NIP-29 group id = sale).
          room_id: SALE,
        }),
      );
      expect(created).toEqual([SALE]);
    });

    it('9007 failure → failed (no room.created emit)', async () => {
      const m = build({
        findToken: makeToken({ nostr_room_state: 'pending' }),
      });
      const created: string[] = [];
      m.emitter.on(TGR_ROOM_CREATED, (p: { saleAddress: string }) =>
        created.push(p.saleAddress),
      );

      await m.service.onPublishAck({
        saleAddress: SALE,
        kind: NIP29_KIND.CREATE_GROUP,
        ok: false,
      });

      expect(m.update).toHaveBeenCalledWith(
        { sale_address: SALE, nostr_room_state: 'pending' },
        { nostr_room_state: 'failed' },
      );
      expect(created).toEqual([]);
    });

    it('ignores member-level acks (9000/9001 carry a pubkey → Task 10)', async () => {
      const m = build({
        findToken: makeToken({ nostr_room_state: 'pending' }),
      });
      await m.service.onPublishAck({
        saleAddress: SALE,
        kind: NIP29_KIND.PUT_USER,
        pubkey: 'a'.repeat(64),
        ok: true,
      });
      expect(m.update).not.toHaveBeenCalled();
    });

    it('no-op when the token is missing / already created', async () => {
      const m = build({
        findToken: makeToken({ nostr_room_state: 'created' }),
      });
      await m.service.onPublishAck({
        saleAddress: SALE,
        kind: NIP29_KIND.CREATE_GROUP,
        ok: true,
      });
      expect(m.update).not.toHaveBeenCalled();
    });
  });

  // ── boot safety ─────────────────────────────────────────────────────────────
  describe('onApplicationBootstrap boot safety', () => {
    // Eager boot backfill arms ONLY when BOTH (a) a relay is configured on the
    // injected tgrConfig (`isRelayConfigured(this.config)`) AND (b) the
    // `TG_BACKFILL_ON_BOOT=true` env flag is set — `shouldBackfillOnBoot()` is the
    // conjunction. The relay-config half replaces the old worker-mode gate; the
    // env flag is unchanged (boot-safe default off, so we still toggle it here).
    const saved = process.env.TG_BACKFILL_ON_BOOT;
    afterEach(() => {
      if (saved === undefined) delete process.env.TG_BACKFILL_ON_BOOT;
      else process.env.TG_BACKFILL_ON_BOOT = saved;
    });

    it('does NOT enqueue anything on init by default (no relay, flag unset)', async () => {
      delete process.env.TG_BACKFILL_ON_BOOT;
      const m = build();
      await m.service.onApplicationBootstrap();
      expect(m.backfillQueue.add).not.toHaveBeenCalled();
    });

    it('does NOT enqueue with a relay configured when TG_BACKFILL_ON_BOOT is off', async () => {
      delete process.env.TG_BACKFILL_ON_BOOT;
      const m = build({ relayConfigured: true });
      await m.service.onApplicationBootstrap();
      expect(m.backfillQueue.add).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when TG_BACKFILL_ON_BOOT=true but no relay is configured', async () => {
      process.env.TG_BACKFILL_ON_BOOT = 'true';
      const m = build(); // relay NOT configured
      await m.service.onApplicationBootstrap();
      expect(m.backfillQueue.add).not.toHaveBeenCalled();
    });

    it('enqueues kickoff + stale-sweep only when a relay is configured AND TG_BACKFILL_ON_BOOT=true', async () => {
      process.env.TG_BACKFILL_ON_BOOT = 'true';
      const m = build({ relayConfigured: true });
      await m.service.onApplicationBootstrap();
      expect(m.backfillQueue.add).toHaveBeenCalledTimes(2);
      const names = m.backfillQueue.add.mock.calls.map((c) => c[0]);
      expect(names).toContain('backfill-kickoff');
      expect(names).toContain('backfill-stale-sweep');
    });
  });

  // ── reactive auto-create on token launch (tgr.community.upserted) ───────────
  describe('onCommunityUpserted (reactive room create)', () => {
    it('requests the room for the token when a relay is configured', async () => {
      const token = makeToken();
      const m = build({ findToken: token, relayConfigured: true });
      const spy = jest.spyOn(m.service, 'requestRoom').mockResolvedValue({
        saleAddress: token.sale_address,
        requested: true,
        state: 'pending',
      } as any);

      await m.service.onCommunityUpserted({ saleAddress: token.sale_address });

      expect(m.tokenRepo.findOne).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(token);
    });

    it('is a no-op when no relay is configured (nothing to create)', async () => {
      const m = build({ findToken: makeToken() }); // relay NOT configured
      const spy = jest.spyOn(m.service, 'requestRoom');
      await m.service.onCommunityUpserted({ saleAddress: 'ct_x' });
      expect(spy).not.toHaveBeenCalled();
      // Gated BEFORE the lookup — the token is never even fetched.
      expect(m.tokenRepo.findOne).not.toHaveBeenCalled();
    });

    it('no-ops when the token row is not found', async () => {
      const m = build({ findToken: undefined, relayConfigured: true }); // tokenRepo.findOne → null
      const spy = jest.spyOn(m.service, 'requestRoom');
      await m.service.onCommunityUpserted({ saleAddress: 'ct_missing' });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── startBackfill is idempotent (fixed jobId) ───────────────────────────────
  describe('startBackfill', () => {
    it('enqueues a fixed-id kickoff + stale-sweep (collapsed by jobId)', async () => {
      const m = build();
      await m.service.startBackfill();
      expect(m.backfillQueue.add).toHaveBeenCalledTimes(2);
      const [name, , opts] = m.backfillQueue.add.mock.calls[0] as any[];
      expect(name).toBe('backfill-kickoff');
      expect(opts.jobId).toBe('backfill-kickoff');
    });
  });

  // ── group-not-found recovery (relay↔DB desync; relay group vanished) ─────────
  describe('onGroupMissing → recreateRoomGroup', () => {
    const worthyToken = () =>
      makeToken({
        sale_address: SALE,
        symbol: 'TG',
        market_cap: new BigNumber(100),
        holders_count: 5,
      });

    it('re-publishes 9007 + 9002 and marks the group missing (debounced)', async () => {
      const m = build({
        relayConfigured: true,
        findToken: worthyToken(),
        isPrivateRow: null,
      });

      await m.service.onGroupMissing({ saleAddress: SALE });

      // 9007 create + 9002 metadata re-published onto the publish queue.
      expect(m.publishQueue.add).toHaveBeenCalledTimes(2);
      const kinds = m.publishQueue.add.mock.calls.map(
        (c: any[]) => c[0].template.kind,
      );
      expect(kinds).toEqual([
        NIP29_KIND.CREATE_GROUP,
        NIP29_KIND.EDIT_METADATA,
      ]);
      // Suppressed so membership-sync stops adding members until it is re-created.
      expect(m.groupMissing.isMissing(SALE)).toBe(true);
    });

    it('debounces: a second event while a re-create is in flight does nothing', async () => {
      const m = build({
        relayConfigured: true,
        findToken: worthyToken(),
        isPrivateRow: null,
      });

      await m.service.onGroupMissing({ saleAddress: SALE });
      m.publishQueue.add.mockClear();
      await m.service.onGroupMissing({ saleAddress: SALE });

      expect(m.publishQueue.add).not.toHaveBeenCalled(); // coalesced
    });

    it('worth-gate: a 0-market-cap / <2-holder token is NOT re-created', async () => {
      const m = build({
        relayConfigured: true,
        findToken: makeToken({
          sale_address: SALE,
          symbol: 'TG',
          market_cap: new BigNumber(0),
          holders_count: 1,
        }),
        isPrivateRow: null,
      });

      await m.service.onGroupMissing({ saleAddress: SALE });

      expect(m.publishQueue.add).not.toHaveBeenCalled();
    });

    it('is a no-op when no relay is configured', async () => {
      const m = build({ findToken: makeToken({ sale_address: SALE }) });
      await m.service.onGroupMissing({ saleAddress: SALE });
      expect(m.publishQueue.add).not.toHaveBeenCalled();
      expect(m.groupMissing.isMissing(SALE)).toBe(false);
    });
  });

  describe('onPublishAck: 9007 ok for a missing group → clear + re-fire tgr.room.created', () => {
    it('clears the suppression and re-emits tgr.room.created so members re-add', async () => {
      const m = build({ relayConfigured: true });
      m.groupMissing.markMissing(SALE);
      const roomCreated: any[] = [];
      m.emitter.on(TGR_ROOM_CREATED, (p) => roomCreated.push(p));

      await m.service.onPublishAck({
        saleAddress: SALE,
        kind: NIP29_KIND.CREATE_GROUP,
        ok: true,
      });

      expect(m.groupMissing.isMissing(SALE)).toBe(false);
      expect(roomCreated).toEqual([{ saleAddress: SALE }]);
    });

    it('does nothing for a group that was not flagged missing', async () => {
      const m = build({ relayConfigured: true });
      const roomCreated: any[] = [];
      m.emitter.on(TGR_ROOM_CREATED, (p) => roomCreated.push(p));

      await m.service.onPublishAck({
        saleAddress: SALE,
        kind: NIP29_KIND.CREATE_GROUP,
        ok: true,
      });

      expect(roomCreated).toHaveLength(0);
    });
  });
});

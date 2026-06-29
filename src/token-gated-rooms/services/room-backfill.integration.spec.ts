import 'dotenv/config';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Queue } from 'bull';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomBackfillState } from '../entities/room-backfill-state.entity';
import { NIP29_KIND } from '../nostr/nip29';
import { TGR_ROOM_CREATED } from '../events';
import type { PublishNip29Job } from '../queues/publish-nip29.types';
import { RoomBackfillService } from './room-backfill.service';

/**
 * DB integration for the eager room backfill (Task 09). Mirrors the Task 04
 * isolated-schema harness (`community-room-state.integration.spec.ts`): a real
 * Postgres backs `token` + `community_room` + `room_backfill_state` in a DEDICATED
 * `tgr09_test` schema (created/dropped here, `synchronize: true`), so the
 * whole-registry backfill is naturally scoped and never touches the shared
 * `public` schema (54k real tokens).
 *
 * The relay WRITE path (the `worker:publish-nip29` queue) is the Task 07 contract;
 * here we mock the queue + the Task 08 `RoomAdminsService` and drive the state
 * machine by replaying the `tgr.publish.ack` the publish processor would emit. No
 * relay socket is opened — the relay-backed throughput run is the flagged load
 * test (§6.2), not this DB test. Asserts:
 *  - the working-set predicate + deterministic page ordering;
 *  - request → pending, ack → created (has_nostr_room=true, room.created emitted);
 *  - IDEMPOTENT re-run: re-deriving the working set yields no created tokens to
 *    re-request and re-requesting a still-pending token does not double-create;
 *  - RESUME after a mid-batch interrupt: the predicate completes the remainder.
 *
 * Requires the local Postgres (`DB_HOST`); auto-skips otherwise so unit-only runs
 * stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const SCHEMA = 'tgr09_test';

d('Eager room backfill (integration)', () => {
  let ds: DataSource;
  let tokenRepo: Repository<Token>;
  let roomRepo: Repository<CommunityRoom>;
  let stateRepo: Repository<RoomBackfillState>;
  let emitter: EventEmitter2;
  let service: RoomBackfillService;
  let publishQueue: jest.Mocked<Pick<Queue, 'add'>>;
  let backfillQueue: jest.Mocked<Pick<Queue, 'add'>>;
  let seedRoomAdmins: jest.Mock;

  const makeTokenRow = (sale: string, symbol: string): Partial<Token> => ({
    sale_address: sale,
    address: 'ct_token_' + sale,
    name: symbol + 'Name',
    symbol,
    owner_address: 'ak_owner_' + sale,
    creator_address: 'ak_creator_' + sale,
  });

  /** Replay the ACK the publish processor would emit for one publish job. */
  const ack = (saleAddress: string, kind: number, ok = true): Promise<void> =>
    service.onPublishAck({ saleAddress, kind, ok });

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
      entities: [Token, CommunityRoom, RoomBackfillState],
    });
    await ds.initialize();

    tokenRepo = ds.getRepository(Token);
    roomRepo = ds.getRepository(CommunityRoom);
    stateRepo = ds.getRepository(RoomBackfillState);
  }, 60_000);

  beforeEach(async () => {
    await roomRepo.clear();
    await tokenRepo.clear();
    await stateRepo.clear();

    emitter = new EventEmitter2();
    publishQueue = { add: jest.fn().mockResolvedValue({ id: 'p' }) } as any;
    backfillQueue = { add: jest.fn().mockResolvedValue({ id: 'b' }) } as any;
    seedRoomAdmins = jest.fn().mockResolvedValue(1);

    service = new RoomBackfillService(
      tokenRepo,
      roomRepo,
      stateRepo,
      publishQueue as unknown as Queue<PublishNip29Job>,
      backfillQueue as unknown as Queue,
      { seedRoomAdmins } as any,
      emitter,
      { backfillBatchSize: 2, publishMaxRetries: 5 } as any,
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

  it('creates N rooms for N tokens and converges all to created / has_nostr_room=true', async () => {
    await tokenRepo.save([
      tokenRepo.create(makeTokenRow('ct_a', 'AAA')),
      tokenRepo.create(makeTokenRow('ct_b', 'BBB')),
      tokenRepo.create(makeTokenRow('ct_c', 'CCC')),
    ]);

    const created: string[] = [];
    emitter.on(TGR_ROOM_CREATED, (p: { saleAddress: string }) =>
      created.push(p.saleAddress),
    );

    // Walk the pages (batchSize=2 → page1: a,b ; page2: c).
    const p1 = await service.processPage();
    expect(p1.requested).toBe(2);
    expect(p1.hasMore).toBe(true);
    const p2 = await service.processPage(p1.nextCursor);
    expect(p2.requested).toBe(1);
    expect(p2.hasMore).toBe(false);

    // All three requested → pending, group id stamped, 2 publishes + 1 seed each.
    for (const sale of ['ct_a', 'ct_b', 'ct_c']) {
      const t = await tokenRepo.findOneByOrFail({ sale_address: sale });
      expect(t.nostr_room_state).toBe('pending');
      expect(t.nostr_group_id).toBe(sale);
      expect(t.has_nostr_room).toBe(false);
    }
    expect(publishQueue.add).toHaveBeenCalledTimes(6); // 3 tokens × (9007+9002)
    expect(seedRoomAdmins).toHaveBeenCalledTimes(3);

    // Replay the relay 9007 ok ack for each → created.
    for (const sale of ['ct_a', 'ct_b', 'ct_c']) {
      await ack(sale, NIP29_KIND.CREATE_GROUP, true);
    }

    for (const sale of ['ct_a', 'ct_b', 'ct_c']) {
      const t = await tokenRepo.findOneByOrFail({ sale_address: sale });
      expect(t.nostr_room_state).toBe('created');
      expect(t.has_nostr_room).toBe(true);
      expect(t.nostr_room_created_at).toBeInstanceOf(Date);
    }
    expect(created.sort()).toEqual(['ct_a', 'ct_b', 'ct_c']);

    // Working set is now empty.
    expect(await service.pendingCount()).toBe(0);
  });

  it('is idempotent: re-running after created produces no new requests', async () => {
    await tokenRepo.save([tokenRepo.create(makeTokenRow('ct_a', 'AAA'))]);

    await service.processPage();
    await ack('ct_a', NIP29_KIND.CREATE_GROUP, true);
    const callsAfterFirst = publishQueue.add.mock.calls.length;

    // A second sweep re-derives the working set from the predicate — the created
    // token drops out, so nothing is re-requested.
    const again = await service.processPage();
    expect(again.requested).toBe(0);
    expect(publishQueue.add.mock.calls.length).toBe(callsAfterFirst);

    const t = await tokenRepo.findOneByOrFail({ sale_address: 'ct_a' });
    expect(t.nostr_room_state).toBe('created');
  });

  it('re-requesting a still-pending token does not double-create (re-publish in place)', async () => {
    await tokenRepo.save([tokenRepo.create(makeTokenRow('ct_a', 'AAA'))]);

    // First pass: pending (no ack yet).
    await service.processPage();
    let t = await tokenRepo.findOneByOrFail({ sale_address: 'ct_a' });
    expect(t.nostr_room_state).toBe('pending');

    // Interrupt + resume: the predicate still selects the pending token (not yet
    // created) → re-request re-publishes in place, state stays pending.
    const resume = await service.processPage();
    expect(resume.requested).toBe(1);
    t = await tokenRepo.findOneByOrFail({ sale_address: 'ct_a' });
    expect(t.nostr_room_state).toBe('pending');
    expect(t.has_nostr_room).toBe(false);

    // A single create ack now converges it to created exactly once.
    await ack('ct_a', NIP29_KIND.CREATE_GROUP, true);
    t = await tokenRepo.findOneByOrFail({ sale_address: 'ct_a' });
    expect(t.nostr_room_state).toBe('created');
    expect(t.has_nostr_room).toBe(true);
  });

  it('resume after a mid-batch interrupt: the full set converges to created', async () => {
    await tokenRepo.save([
      tokenRepo.create(makeTokenRow('ct_a', 'AAA')),
      tokenRepo.create(makeTokenRow('ct_b', 'BBB')),
      tokenRepo.create(makeTokenRow('ct_c', 'CCC')),
      tokenRepo.create(makeTokenRow('ct_d', 'DDD')),
    ]);

    // "Crash" after the first page only (a, b requested + acked).
    const p1 = await service.processPage();
    expect(p1.requested).toBe(2);
    await ack('ct_a', NIP29_KIND.CREATE_GROUP, true);
    await ack('ct_b', NIP29_KIND.CREATE_GROUP, true);

    // Restart: working set re-derives → only c, d remain.
    expect(await service.pendingCount()).toBe(2);
    let next = await service.processPage();
    expect(next.requested).toBe(2);
    expect(next.hasMore).toBe(true);
    // (a short final empty page would report !hasMore; with exactly 2 remaining
    // and batchSize 2 the page is full, so a follow-up page is checked.)
    next = await service.processPage(next.nextCursor);
    expect(next.requested).toBe(0);

    await ack('ct_c', NIP29_KIND.CREATE_GROUP, true);
    await ack('ct_d', NIP29_KIND.CREATE_GROUP, true);

    for (const sale of ['ct_a', 'ct_b', 'ct_c', 'ct_d']) {
      const t = await tokenRepo.findOneByOrFail({ sale_address: sale });
      expect(t.nostr_room_state).toBe('created');
      expect(t.has_nostr_room).toBe(true);
    }
    expect(await service.pendingCount()).toBe(0);
  });

  it('a 9007 failure ack drives pending → failed; a retry re-requests it', async () => {
    await tokenRepo.save([tokenRepo.create(makeTokenRow('ct_a', 'AAA'))]);

    await service.processPage();
    await ack('ct_a', NIP29_KIND.CREATE_GROUP, false); // retries exhausted

    let t = await tokenRepo.findOneByOrFail({ sale_address: 'ct_a' });
    expect(t.nostr_room_state).toBe('failed');
    expect(t.has_nostr_room).toBe(false);

    // failed is still in the working set (NOT IN created,deleted) → retried.
    expect(await service.pendingCount()).toBe(1);
    const retry = await service.processPage();
    expect(retry.requested).toBe(1);
    t = await tokenRepo.findOneByOrFail({ sale_address: 'ct_a' });
    expect(t.nostr_room_state).toBe('pending');

    await ack('ct_a', NIP29_KIND.CREATE_GROUP, true);
    t = await tokenRepo.findOneByOrFail({ sale_address: 'ct_a' });
    expect(t.nostr_room_state).toBe('created');
  });

  it('derives 9002 visibility from community_room.is_private (private) and default public', async () => {
    await tokenRepo.save([
      tokenRepo.create(makeTokenRow('ct_priv', 'PRV')),
      tokenRepo.create(makeTokenRow('ct_pub', 'PUB')),
    ]);
    // Only the private one has a community_room row.
    await roomRepo.save(
      roomRepo.create({
        sale_address: 'ct_priv',
        token_address: 'ct_token_ct_priv',
        symbol: 'PRV',
        owner_address: 'ak_o',
        is_private: true,
        is_community: true,
      }),
    );

    await service.requestRoom(
      await tokenRepo.findOneByOrFail({ sale_address: 'ct_priv' }),
    );
    await service.requestRoom(
      await tokenRepo.findOneByOrFail({ sale_address: 'ct_pub' }),
    );

    // Find the 9002 edit-metadata jobs and check their visibility tag.
    const editJobs = publishQueue.add.mock.calls
      .map((c) => c[0] as unknown as PublishNip29Job)
      .filter((j) => j.template.kind === NIP29_KIND.EDIT_METADATA);

    const privJob = editJobs.find((j) => j.groupId === 'ct_priv');
    const pubJob = editJobs.find((j) => j.groupId === 'ct_pub');
    expect(privJob.template.tags.map((t) => t[0])).toContain('private');
    expect(pubJob.template.tags.map((t) => t[0])).toContain('public');
  });

  it('deleted is terminal: never re-requested by the working set', async () => {
    await tokenRepo.save([
      tokenRepo.create({
        ...makeTokenRow('ct_del', 'DEL'),
        nostr_room_state: 'deleted',
      }),
    ]);
    expect(await service.pendingCount()).toBe(0);
    const page = await service.processPage();
    expect(page.requested).toBe(0);
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('persists the resume cursor in room_backfill_state', async () => {
    await tokenRepo.save([
      tokenRepo.create(makeTokenRow('ct_a', 'AAA')),
      tokenRepo.create(makeTokenRow('ct_b', 'BBB')),
    ]);
    await service.processPage();
    expect(await service.cursorOffset()).toBe(2);
    const row = await stateRepo.findOneByOrFail({ id: 'global' });
    expect(row.batch_offset).toBe(2);
  });
});

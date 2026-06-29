import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  CommunityRoomBackfillService,
  ROOM_PROVISION_SCAN_JOB,
} from './community-room-backfill.service';
import { TGR_COMMUNITY_UPSERTED } from '../events';
import type { Token } from '@/tokens/entities/token.entity';

/**
 * Unit coverage for the resumable backfill loop (Task 04 req §6) + the roomless-
 * token provisioning cron / buy-listener (room_id source-of-truth).
 *
 * We mock the `Token` query builder to hand out batches and the
 * `RoomStateService.readAndUpsertRoomState` per-token call. Asserts: batching,
 * per-token error isolation (a failed read does not abort the batch), the
 * loop-guard against a non-progressing repeated batch, and emission counting.
 */
describe('CommunityRoomBackfillService', () => {
  const makeToken = (sale: string): Token =>
    ({ sale_address: sale, address: 'ct_' + sale, symbol: sale }) as Token;

  type Harness = {
    service: CommunityRoomBackfillService;
    upsert: jest.Mock;
    emitter: EventEmitter2;
    emitSpy: jest.SpyInstance;
    tokenRepo: any;
    qb: any;
    scheduler: SchedulerRegistry;
    setBatches: (batches: Token[][]) => void;
  };

  /**
   * Build the service against a mock config. The relay-actuator duties (the
   * 5-min provisioning cron + the buy-listener) gate on `isRelayConfigured`,
   * which reads the INJECTED `nostrRelayUrl` + `nostrBotNsec`. Pass
   * `relayConfigured: true` to set both (gate OPEN → cron scheduled / listener
   * active); leave it false to keep them unset (gate CLOSED → dormant).
   */
  const makeHarness = (
    upsertImpl?: (t: Token) => any,
    opts: { relayConfigured?: boolean } = {},
  ): Harness => {
    let batches: Token[][] = [];
    let call = 0;

    // Each createQueryBuilder().…​.getMany() returns the next queued batch.
    // Methods are jest.fn so tests can assert the worth-gate filters + ordering.
    const qb: any = {
      leftJoin: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      addOrderBy: jest.fn(() => qb),
      limit: jest.fn(() => qb),
      getMany: jest.fn(async () => batches[call++] ?? []),
      getCount: jest.fn(async () => 0),
    };
    const tokenRepo = {
      createQueryBuilder: () => qb,
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
    } as any;
    const communityRoomRepo = {} as any;

    const upsert = jest.fn(
      upsertImpl ??
        (async (t: Token) => ({
          saleAddress: t.sale_address,
          emitted: true,
          isCommunity: true,
          deleted: false,
        })),
    );
    const roomStateService = {
      readAndUpsertRoomState: upsert,
    } as any;
    const config = {
      backfillBatchSize: 2,
      roomProvisionBatchSize: 500,
      // Relay-enable switch (replaces the old TG_WORKER_MODE process mode):
      // both set → isRelayConfigured(config) === true.
      nostrRelayUrl: opts.relayConfigured ? 'ws://relay' : undefined,
      nostrBotNsec: opts.relayConfigured ? 'nsec1abc' : undefined,
    } as any;

    const emitter = new EventEmitter2();
    const emitSpy = jest.spyOn(emitter, 'emit');
    const scheduler = new SchedulerRegistry();

    const service = new CommunityRoomBackfillService(
      tokenRepo,
      communityRoomRepo,
      roomStateService,
      emitter,
      scheduler,
      config,
    );

    return {
      service,
      upsert,
      emitter,
      emitSpy,
      tokenRepo,
      qb,
      scheduler,
      setBatches: (b) => {
        batches = b;
      },
    };
  };

  it('processes every token across multiple batches until exhausted', async () => {
    const h = makeHarness();
    h.setBatches([
      [makeToken('a'), makeToken('b')],
      [makeToken('c')],
      [], // exhausted
    ]);

    const result = await h.service.run();

    expect(h.upsert).toHaveBeenCalledTimes(3);
    expect(result.processed).toBe(3);
    expect(result.emitted).toBe(3);
    expect(result.failed).toBe(0);
  });

  it('counts only emitting upserts in `emitted` (idempotent no-diff re-runs)', async () => {
    const h = makeHarness(async (t: Token) => ({
      saleAddress: t.sale_address,
      emitted: t.sale_address === 'a', // only "a" actually changed
      isCommunity: true,
      deleted: false,
    }));
    h.setBatches([[makeToken('a'), makeToken('b')], []]);

    const result = await h.service.run();
    expect(result.processed).toBe(2);
    expect(result.emitted).toBe(1);
  });

  it('isolates a per-token failure (the batch continues; failed counted)', async () => {
    const h = makeHarness(async (t: Token) => {
      if (t.sale_address === 'b') {
        throw new Error('get_state reverted');
      }
      return {
        saleAddress: t.sale_address,
        emitted: true,
        isCommunity: true,
        deleted: false,
      };
    });
    h.setBatches([[makeToken('a'), makeToken('b'), makeToken('c')], []]);

    const result = await h.service.run();
    expect(h.upsert).toHaveBeenCalledTimes(3); // b failed but a + c still ran
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('stops on a non-progressing repeated batch (loop-guard)', async () => {
    // Every read fails → state_synced_at never set → the same batch would repeat
    // forever. The guard detects the identical set with zero progress and stops.
    const h = makeHarness(async () => {
      throw new Error('always fails');
    });
    const batch = [makeToken('a'), makeToken('b')];
    h.setBatches([batch, batch, batch, batch]);

    const result = await h.service.run();
    // First batch ran (all failed); the repeat of the identical set stops it.
    expect(result.failed).toBe(4); // two batches of two before the guard trips
    expect(result.processed).toBe(0);
  });

  it('honours an explicit batchSize / maxBatches override', async () => {
    const h = makeHarness();
    h.setBatches([[makeToken('a')], [makeToken('b')], [makeToken('c')]]);

    const result = await h.service.run({ batchSize: 1, maxBatches: 2 });
    expect(result.processed).toBe(2); // capped at 2 batches
  });

  // ── roomless-token provisioning cron (room_id source-of-truth) ──────────────
  describe('provisionRoomlessTokens', () => {
    it('calls readAndUpsertRoomState per token and force-emits ONLY when !emitted', async () => {
      // "a" emits on its own (first creation); "b" does not (community_room exists,
      // room_id still NULL → retry case) → force-emit fires only for "b".
      const h = makeHarness(async (t: Token) => ({
        saleAddress: t.sale_address,
        emitted: t.sale_address === 'a',
        isCommunity: true,
        deleted: false,
      }));
      const tokenA = makeToken('a');
      const tokenB = makeToken('b');
      // provisionRoomlessTokens now selects via a query builder (market_cap > 0 AND
      // holders_count >= 2, ORDER BY market_cap DESC) → feed the qb.getMany batch.
      h.setBatches([[tokenA, tokenB]]);

      const processed = await h.service.provisionRoomlessTokens(500);

      // readAndUpsertRoomState called once per token.
      expect(h.upsert).toHaveBeenCalledTimes(2);
      expect(h.upsert).toHaveBeenCalledWith(tokenA);
      expect(h.upsert).toHaveBeenCalledWith(tokenB);
      expect(processed).toBe(2);

      // Force-emit fires ONLY for the emitted:false token ("b").
      const upsertEmits = h.emitSpy.mock.calls.filter(
        (c) => c[0] === TGR_COMMUNITY_UPSERTED,
      );
      expect(upsertEmits).toHaveLength(1);
      expect(upsertEmits[0][1]).toEqual({ saleAddress: 'b' });
    });

    it('worth-gates + prioritizes: market_cap > 0 AND holders_count >= 2, ORDER BY market_cap DESC', async () => {
      const h = makeHarness();
      h.setBatches([[makeToken('a')]]);

      await h.service.provisionRoomlessTokens(100);

      const andWhereArgs = h.qb.andWhere.mock.calls.map((c: any[]) => c[0]);
      expect(andWhereArgs).toEqual(
        expect.arrayContaining([
          'token.market_cap > 0',
          'token.holders_count >= 2',
        ]),
      );
      expect(h.qb.orderBy).toHaveBeenCalledWith('token.market_cap', 'DESC');
      expect(h.qb.limit).toHaveBeenCalledWith(100);
    });

    it('isolates a per-token failure (the batch continues; count excludes it)', async () => {
      const h = makeHarness(async (t: Token) => {
        if (t.sale_address === 'b') {
          throw new Error('get_state reverted');
        }
        return {
          saleAddress: t.sale_address,
          emitted: false,
          isCommunity: true,
          deleted: false,
        };
      });
      h.setBatches([[makeToken('a'), makeToken('b'), makeToken('c')]]);

      const processed = await h.service.provisionRoomlessTokens(500);
      expect(h.upsert).toHaveBeenCalledTimes(3); // b failed but a + c still ran
      expect(processed).toBe(2);
    });
  });

  // ── 5-min provisioning cron gate (onModuleInit) ─────────────────────────────
  describe('onModuleInit (cron gate)', () => {
    afterEach(() => jest.clearAllMocks());

    it('schedules the 5-min provisioning interval when the relay IS configured', () => {
      const h = makeHarness(undefined, { relayConfigured: true });
      const addInterval = jest.spyOn(h.scheduler, 'addInterval');

      h.service.onModuleInit();

      expect(addInterval).toHaveBeenCalledTimes(1);
      expect(addInterval.mock.calls[0][0]).toBe(ROOM_PROVISION_SCAN_JOB);
      expect(h.scheduler.doesExist('interval', ROOM_PROVISION_SCAN_JOB)).toBe(
        true,
      );

      // Tidy up the registered timer.
      h.service.onApplicationShutdown();
    });

    it('does NOT schedule the interval when the relay is NOT configured (dormant)', () => {
      const h = makeHarness(undefined, { relayConfigured: false });
      const addInterval = jest.spyOn(h.scheduler, 'addInterval');

      h.service.onModuleInit();

      expect(addInterval).not.toHaveBeenCalled();
      expect(h.scheduler.doesExist('interval', ROOM_PROVISION_SCAN_JOB)).toBe(
        false,
      );
    });
  });

  // ── buy → create-if-missing (onBalanceChanged) ──────────────────────────────
  // The buy-listener is relay-gated: it only provisions when a relay is
  // configured (`isRelayConfigured(this.config)`), since there is a room to
  // create. With no relay it returns early (dormant) — replaces the old
  // pure-main / worker process-mode distinction.
  describe('onBalanceChanged (buy → create room if missing)', () => {
    it('provisions a roomless token (room_id NULL): upsert + force-emit', async () => {
      const h = makeHarness(
        async (t: Token) => ({
          saleAddress: t.sale_address,
          emitted: false, // community_room exists → force-emit path
          isCommunity: true,
          deleted: false,
        }),
        { relayConfigured: true }, // relay configured → listener active
      );
      const token = {
        sale_address: 'sale_x',
        address: 'ct_aex9_x',
        room_id: null,
      } as unknown as Token;
      h.tokenRepo.findOne.mockResolvedValue(token);

      await h.service.onBalanceChanged({
        tokenAddress: 'ct_aex9_x',
        holderAddress: 'ak_buyer',
      });

      // Resolved by AEX9 address (NOT sale_address).
      expect(h.tokenRepo.findOne).toHaveBeenCalledWith({
        where: { address: 'ct_aex9_x' },
      });
      expect(h.upsert).toHaveBeenCalledWith(token);
      const upsertEmits = h.emitSpy.mock.calls.filter(
        (c) => c[0] === TGR_COMMUNITY_UPSERTED,
      );
      expect(upsertEmits).toEqual([
        [TGR_COMMUNITY_UPSERTED, { saleAddress: 'sale_x' }],
      ]);
    });

    it('is a no-op for a token that already has room_id set', async () => {
      const h = makeHarness(undefined, { relayConfigured: true });
      h.tokenRepo.findOne.mockResolvedValue({
        sale_address: 'sale_y',
        address: 'ct_aex9_y',
        room_id: 'sale_y', // already confirmed-created
      } as unknown as Token);

      await h.service.onBalanceChanged({
        tokenAddress: 'ct_aex9_y',
        holderAddress: 'ak_buyer',
      });

      expect(h.upsert).not.toHaveBeenCalled();
      const upsertEmits = h.emitSpy.mock.calls.filter(
        (c) => c[0] === TGR_COMMUNITY_UPSERTED,
      );
      expect(upsertEmits).toHaveLength(0);
    });

    it('is a no-op when the relay is NOT configured (no room to create)', async () => {
      const h = makeHarness(undefined, { relayConfigured: false });
      await h.service.onBalanceChanged({
        tokenAddress: 'ct_aex9_z',
        holderAddress: 'ak_buyer',
      });
      expect(h.tokenRepo.findOne).not.toHaveBeenCalled();
      expect(h.upsert).not.toHaveBeenCalled();
    });
  });
});

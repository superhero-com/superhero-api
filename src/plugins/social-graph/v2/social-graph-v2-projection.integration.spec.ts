import { SocialGraphV2OutboxService } from './social-graph-v2-outbox.service';
import { SocialGraphV2WorkerService } from './social-graph-v2-worker.service';
import { SocialGraphV2ReconcileService } from './social-graph-v2-reconcile.service';
import { SocialGraphV2CatchupService } from './social-graph-v2-catchup.service';
import { SocialGraphV2QueryService } from './social-graph-v2-query.service';
import { SocialGraphV2SnapshotService } from './social-graph-v2-snapshot.service';
import { encodeGraphCursor } from './social-graph-v2-reader';
import { DataSource } from 'typeorm';
import {
  findPostgresBinDir,
  startPostgres,
  PostgresHandle,
} from '@/test/reward-e2e/postgres';
import { SocialGraphV2Projection1718900000035 } from '@/migrations/1718900000035-SocialGraphV2Projection';
import { SocialGraphV2ProjectionService } from './social-graph-v2-projection.service';
const bin = findPostgresBinDir();
(bin ? describe : describe.skip)('V2 projection on real PostgreSQL', () => {
  let pg: PostgresHandle,
    db: DataSource,
    service: SocialGraphV2ProjectionService;
  const scope = { network: 'ae_dev', contract: 'ct_source', generation: '1' };
  const edge = {
    from: 'ak_a',
    to: 'ak_b',
    kind: 'follow' as const,
    present: true,
  };
  const event = (transaction: string) => ({
    transaction,
    index: 0,
    height: '100',
  });
  beforeAll(async () => {
    pg = await startPostgres(bin!);
    db = new DataSource({ type: 'postgres', url: pg.url });
    await db.initialize();
    const q = db.createQueryRunner();
    try {
      await new SocialGraphV2Projection1718900000035().up(q);
    } finally {
      await q.release();
    }
    service = new SocialGraphV2ProjectionService(db);
  }, 30000);
  afterAll(async () => {
    await db?.destroy();
    pg?.stop();
  });
  beforeEach(async () => {
    for (const table of [
      'outbox',
      'events',
      'edges',
      'counts',
      'dirty',
      'rates',
      'scopes',
    ])
      await db.query(`TRUNCATE social_graph_v2_${table}`);
    await db.query(
      "INSERT INTO social_graph_v2_scopes(network,contract,generation,state) VALUES('ae_dev','ct_source',1,'ready'),('ae_dev','ct_destination',1,'ready')",
    );
  });
  it('deduplicates concurrent replay and counts only actual mutations', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.applyEvent(scope, event('th_one'), [edge]),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await service.applyEvent(scope, event('th_duplicate_edge'), [edge]);
    const count = await db.query(
      "SELECT followers,following FROM social_graph_v2_counts WHERE address='ak_b'",
    );
    expect(count[0]).toEqual({ followers: '1', following: '0' });
    await service.applyEvent(scope, event('th_remove'), [
      { ...edge, present: false },
    ]);
    await service.applyEvent(scope, event('th_remove_again'), [
      { ...edge, present: false },
    ]);
    expect(
      (
        await db.query(
          "SELECT followers FROM social_graph_v2_counts WHERE address='ak_b'",
        )
      )[0].followers,
    ).toBe('0');
  });
  it('keeps source and destination independent and preserves deletion activity', async () => {
    await service.applyEvent(scope, event('th_one'), [edge]);
    await service.applyEvent(
      { ...scope, contract: 'ct_destination' },
      event('th_one'),
      [edge],
    );
    const pending = await service.pending(scope);
    await service.applyEvent(scope, event('th_remove'), [
      { ...edge, present: false },
    ]);
    await service.acknowledge(scope, pending[0].address, pending[0].revision);
    expect(await service.pending(scope)).toHaveLength(2);
    expect(
      (
        await db.query(
          "SELECT COUNT(*)::text AS n FROM social_graph_v2_edges WHERE contract='ct_destination'",
        )
      )[0].n,
    ).toBe('1');
  });
  it('rolls back all earlier mutations and replay identity when a batch fails', async () => {
    await expect(
      service.applyEvent(scope, event('th_bad'), [
        edge,
        { ...edge, kind: 'invalid' as any },
      ]),
    ).rejects.toThrow();
    expect((await db.query('SELECT * FROM social_graph_v2_edges')).length).toBe(
      0,
    );
    expect(
      (await db.query('SELECT * FROM social_graph_v2_events')).length,
    ).toBe(0);
    expect(
      (await db.query('SELECT * FROM social_graph_v2_counts')).length,
    ).toBe(0);
  });
  it('fails closed during a reorg rebuild and bounds the reconciliation queue', async () => {
    await service.invalidateAfterReorg(scope);
    await expect(
      service.applyEvent(scope, event('th_one'), [edge]),
    ).rejects.toThrow('not ready');
    await expect(service.pending(scope, 101)).rejects.toThrow('limit');
  });
  it('resumes empty sparse snapshot pages atomically without producing follow events', async () => {
    const target = { ...scope, generation: '2' };
    const identity = { network: scope.network, contract: scope.contract };
    const reader: any = {
      identity,
      assertCanonical: jest.fn().mockResolvedValue(undefined),
      policy: async () => ({
        block_hash: 'kh_abc',
        height: '100',
        importing: false,
      }),
      page: jest
        .fn()
        .mockResolvedValueOnce({
          ...identity,
          block_hash: 'kh_abc',
          items: [],
          end_cursor: '103',
          next_cursor: encodeGraphCursor({
            ...identity,
            contract: identity.contract as any,
            version: 2,
            direction: 'export',
            account: '',
            top: 'kh_abc',
            offset: '100',
          }),
        })
        .mockResolvedValueOnce({
          ...identity,
          block_hash: 'kh_abc',
          items: [{ Follow: ['ak_a', 'ak_b'] }, { Rate: ['ak_a', '99'] }],
          end_cursor: '103',
          next_cursor: null,
        }),
    };
    const importer = new SocialGraphV2SnapshotService(db, service);
    await importer.begin(target, reader);
    expect(await importer.step(target, reader)).toBe(false);
    const resumed = new SocialGraphV2SnapshotService(db, service);
    expect(await resumed.step(target, reader)).toBe(true);
    const state = (
      await db.query(
        'SELECT state,export_cursor::text FROM social_graph_v2_scopes WHERE generation=2',
      )
    )[0];
    expect(state).toEqual({ state: 'catching-up', export_cursor: '103' });
    expect(await db.query('SELECT * FROM social_graph_v2_events')).toHaveLength(
      0,
    );
    expect(
      (
        await db.query(
          "SELECT followers::text FROM social_graph_v2_counts WHERE generation=2 AND address='ak_b'",
        )
      )[0].followers,
    ).toBe('1');
    expect(
      await service.applyEvent(target, event('before-snapshot'), [
        { ...edge, present: false },
      ]),
    ).toBe(true);
    expect(
      await service.applyEvent(
        target,
        { ...event('old-source'), height: '99' },
        [edge],
      ),
    ).toBe(false);
    expect(
      await db.query('SELECT * FROM social_graph_v2_edges WHERE generation=2'),
    ).toHaveLength(0);
  });
  it('does not advance snapshot checkpoints or retain edges on a malformed page or reorg', async () => {
    const target = { ...scope, generation: '2' };
    const identity = { network: scope.network, contract: scope.contract };
    const reader: any = {
      identity,
      assertCanonical: jest.fn().mockResolvedValue(undefined),
      policy: async () => ({
        block_hash: 'kh_abc',
        height: '100',
        importing: false,
      }),
      page: async () => ({
        ...identity,
        block_hash: 'kh_abc',
        items: [{ Follow: ['ak_a', 'ak_b'] }, { Rate: ['ak_a', '-1'] }],
        end_cursor: '2',
        next_cursor: null,
      }),
    };
    const importer = new SocialGraphV2SnapshotService(db, service);
    await importer.begin(target, reader);
    await expect(importer.step(target, reader)).rejects.toThrow('integer');
    expect(
      await db.query('SELECT * FROM social_graph_v2_edges WHERE generation=2'),
    ).toHaveLength(0);
    expect(
      (
        await db.query(
          'SELECT export_cursor::text FROM social_graph_v2_scopes WHERE generation=2',
        )
      )[0].export_cursor,
    ).toBe('0');
    reader.assertCanonical.mockRejectedValue(
      new Error('Snapshot is no longer canonical'),
    );
    await expect(importer.step(target, reader)).rejects.toThrow('canonical');
  });
  it('serves scoped keyset pages and fails closed after generation cutover', async () => {
    const queries = new SocialGraphV2QueryService(db);
    await service.applyEvent(scope, event('page-1'), [
      edge,
      { ...edge, from: 'ak_c' },
    ]);
    const ready = await queries.ready(scope.network, scope.contract);
    const first = await queries.connections(ready, 'ak_b', 'followers', 1);
    expect(first.addresses).toEqual(['ak_c']);
    expect(first.next_cursor).not.toBeNull();
    const last = await queries.connections(
      ready,
      'ak_b',
      'followers',
      1,
      first.next_cursor,
    );
    expect(last.addresses).toEqual(['ak_a']);
    expect(last.next_cursor).toBeNull();
    expect((await queries.counts(ready, 'ak_b')).followers).toBe('2');
    const tooLarge = JSON.parse(
      Buffer.from(first.next_cursor!, 'base64url').toString(),
    );
    tooLarge.before = '9223372036854775808';
    await expect(
      queries.connections(
        ready,
        'ak_b',
        'followers',
        1,
        Buffer.from(JSON.stringify(tooLarge)).toString('base64url'),
      ),
    ).rejects.toThrow('cursor');
    await expect(
      queries.connections(
        { ...ready, contract: 'ct_destination' },
        'ak_b',
        'followers',
        1,
        first.next_cursor,
      ),
    ).rejects.toThrow('cursor');
    await db.query(
      "INSERT INTO social_graph_v2_scopes(network,contract,generation,state) VALUES('ae_dev','ct_source',2,'importing')",
    );
    await expect(queries.ready(scope.network, scope.contract)).rejects.toThrow(
      'not ready',
    );
    await expect(queries.counts(ready, 'ak_b')).rejects.toThrow('not ready');
    await expect(
      queries.connections(ready, 'ak_b', 'followers', 1),
    ).rejects.toThrow('not ready');
    await service.invalidateAfterReorg(scope);
    await expect(queries.counts(ready, 'ak_b')).rejects.toThrow('not ready');
  });
  it('resumes ordered catch-up and exposes only completed key-block windows', async () => {
    await db.query(
      "UPDATE social_graph_v2_scopes SET snapshot_height=100,snapshot_hash='kh_start'",
    );
    const sync = new SocialGraphV2CatchupService(db, service);
    await sync.begin(scope, { hash: 'kh_end', height: '102' }, 'page1');
    const queries = new SocialGraphV2QueryService(db);
    await expect(queries.ready(scope.network, scope.contract)).rejects.toThrow(
      'not ready',
    );
    expect(
      await sync.applyPage(scope, {
        expectedCursor: 'page1',
        nextCursor: 'page2',
        transactions: [
          {
            hash: 'th_add',
            height: '100',
            position: '500',
            events: [{ index: 0, changes: [edge], followAccount: edge.from }],
          },
        ],
      }),
    ).toBe(false);
    const resumed = new SocialGraphV2CatchupService(db, service);
    await expect(
      resumed.applyPage(scope, {
        expectedCursor: 'page1',
        nextCursor: null,
        transactions: [],
      }),
    ).rejects.toThrow('checkpoint');
    expect(
      await resumed.applyPage(scope, {
        expectedCursor: 'page2',
        nextCursor: null,
        transactions: [
          {
            hash: 'th_remove',
            height: '101',
            position: '501',
            events: [{ index: 0, changes: [{ ...edge, present: false }] }],
          },
        ],
      }),
    ).toBe(true);
    const ready = await queries.ready(scope.network, scope.contract);
    expect((await queries.counts(ready, edge.to)).followers).toBe('0');
    expect(
      (
        await db.query(
          "SELECT synced_height,synced_hash FROM social_graph_v2_scopes WHERE contract='ct_source'",
        )
      )[0],
    ).toEqual({ synced_height: '102', synced_hash: 'kh_end' });
    expect(
      (
        await db.query(
          'SELECT last_follow_height::text FROM social_graph_v2_rates',
        )
      )[0].last_follow_height,
    ).toBe('100');
  });
  it('rolls back an entire unordered sync page and rejects cross-page regression', async () => {
    await db.query('UPDATE social_graph_v2_scopes SET snapshot_height=100');
    const sync = new SocialGraphV2CatchupService(db, service);
    await sync.begin(scope, { hash: 'kh_end', height: '103' }, 'page1');
    const tx = {
      hash: 'th_one',
      height: '101',
      position: '500',
      events: [{ index: 0, changes: [edge] }],
    };
    await expect(
      sync.applyPage(scope, {
        expectedCursor: 'page1',
        nextCursor: null,
        transactions: [tx, { ...tx, hash: 'th_two', position: '499' }],
      }),
    ).rejects.toThrow('Unordered');
    expect(await db.query('SELECT * FROM social_graph_v2_edges')).toHaveLength(
      0,
    );
    expect(await db.query('SELECT * FROM social_graph_v2_events')).toHaveLength(
      0,
    );
    await sync.applyPage(scope, {
      expectedCursor: 'page1',
      nextCursor: 'page2',
      transactions: [tx],
    });
    await expect(
      sync.applyPage(scope, {
        expectedCursor: 'page2',
        nextCursor: null,
        transactions: [
          { ...tx, hash: 'th_two', position: '501', height: '100' },
        ],
      }),
    ).rejects.toThrow('Unordered');
    await expect(
      sync.applyPage(scope, {
        expectedCursor: 'page2',
        nextCursor: null,
        transactions: [
          { ...tx, hash: 'th_two', position: '501', height: '103' },
        ],
      }),
    ).rejects.toThrow('out-of-window');
    expect(
      (
        await db.query(
          "SELECT sync_cursor FROM social_graph_v2_scopes WHERE contract='ct_source'",
        )
      )[0].sync_cursor,
    ).toBe('page2');
  });
  it('rejects a stalled continuation and completes an empty final page', async () => {
    await db.query('UPDATE social_graph_v2_scopes SET snapshot_height=100');
    const sync = new SocialGraphV2CatchupService(db, service);
    await sync.begin(scope, { hash: 'kh_end', height: '101' }, 'page1');
    await expect(
      sync.applyPage(scope, {
        expectedCursor: 'page1',
        nextCursor: 'page1',
        transactions: [],
      }),
    ).rejects.toThrow('page');
    expect(
      await sync.applyPage(scope, {
        expectedCursor: 'page1',
        nextCursor: null,
        transactions: [],
      }),
    ).toBe(true);
  });
  it('reconciles deleted accounts at the pinned watermark and fails closed on drift', async () => {
    await service.applyEvent(scope, event('th_add'), [edge]);
    await service.applyEvent(scope, event('th_remove'), [
      { ...edge, present: false },
    ]);
    await db.query(
      "UPDATE social_graph_v2_scopes SET synced_hash='kh_pinned',synced_height=101",
    );
    const reader: any = {
      identity: scope,
      assertCanonical: jest.fn().mockResolvedValue(undefined),
      countsAt: jest
        .fn()
        .mockResolvedValue({ followers: '0', following: '0', blocked: '0' }),
    };
    const reconcile = new SocialGraphV2ReconcileService(db, service);
    expect(await reconcile.step(scope, reader, 1)).toBe(1);
    expect(reader.countsAt).toHaveBeenCalledWith('ak_a', 'kh_pinned');
    expect(await service.pending(scope)).toHaveLength(1);
    reader.countsAt.mockResolvedValue({
      followers: '1',
      following: '0',
      blocked: '0',
    });
    await expect(reconcile.step(scope, reader)).rejects.toThrow('drift');
    expect(await service.pending(scope)).toHaveLength(1);
    await expect(
      new SocialGraphV2QueryService(db).ready(scope.network, scope.contract),
    ).rejects.toThrow('not ready');
  });
  it('does not acknowledge reconciliation when activity changes during the chain read', async () => {
    await service.applyEvent(scope, event('th_add'), [edge]);
    await db.query(
      "UPDATE social_graph_v2_scopes SET synced_hash='kh_pinned',synced_height=101",
    );
    const reader: any = {
      identity: scope,
      assertCanonical: jest.fn().mockResolvedValue(undefined),
      countsAt: async () => {
        await service.applyEvent(scope, event('th_remove'), [
          { ...edge, present: false },
        ]);
        return { followers: '0', following: '1', blocked: '0' };
      },
    };
    expect(
      await new SocialGraphV2ReconcileService(db, service).step(
        scope,
        reader,
        1,
      ),
    ).toBe(0);
    expect(await service.pending(scope)).toHaveLength(2);
  });
  it('defers reconciliation while a live transaction prefix is being applied', async () => {
    await db.query(
      "UPDATE social_graph_v2_scopes SET synced_height=100,synced_hash='kh_start',sync_end_height=101,sync_end_hash='kh_end'",
    );
    await service.applyEvent(scope, event('prefix-follow'), [edge]);
    const reader: any = {
      identity: scope,
      assertCanonical: jest.fn(),
      countsAt: jest.fn(),
    };
    const reconcile = new SocialGraphV2ReconcileService(db, service);
    expect(await reconcile.step(scope, reader)).toBe(0);
    expect(reader.countsAt).not.toHaveBeenCalled();
    expect(await service.pending(scope)).toHaveLength(2);
    expect(
      (await new SocialGraphV2QueryService(db).counts(scope, 'ak_b')).followers,
    ).toBe('1');
  });
  it('discards a connection after advisory unlock failure and permits subsequent worker passes', async () => {
    const previous = process.env.SOCIAL_GRAPH_V2_WORKER_ENABLED;
    process.env.SOCIAL_GRAPH_V2_WORKER_ENABLED = 'true';
    const runner = db.createQueryRunner();
    const query = runner.query.bind(runner);
    const spy = jest
      .spyOn(runner, 'query')
      .mockImplementation(async (sql: string, ...args: any[]) => {
        if (sql.includes('pg_advisory_unlock'))
          throw new Error('simulated unlock failure');
        return query(sql, ...args);
      });
    const factory = jest
      .spyOn(db, 'createQueryRunner')
      .mockReturnValueOnce(runner);
    const reader = {
      identity: scope,
      verifyIdentity: jest.fn(),
      assertCanonical: jest
        .fn()
        .mockRejectedValue(new Error('simulated RPC outage')),
    };
    const worker = new SocialGraphV2WorkerService(
      db,
      {} as any,
      { getReader: () => reader } as any,
      {} as any,
      {} as any,
      {} as any,
      service,
      {} as any,
    );
    try {
      await worker.tick();
      factory.mockRestore();
      spy.mockRestore();
      const probe = db.createQueryRunner();
      try {
        expect(
          (
            await probe.query(
              'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
              [`social-graph-v2:${scope.network}:${scope.contract}`],
            )
          )[0].locked,
        ).toBe(true);
      } finally {
        await probe.query('SELECT pg_advisory_unlock_all()');
        await probe.release();
      }
      await worker.tick();
      expect(reader.verifyIdentity).toHaveBeenCalledTimes(2);
    } finally {
      factory.mockRestore();
      spy.mockRestore();
      if (previous === undefined)
        delete process.env.SOCIAL_GRAPH_V2_WORKER_ENABLED;
      else process.env.SOCIAL_GRAPH_V2_WORKER_ENABLED = previous;
    }
  });
  it('runs a restartable worker from snapshot to live generation, then rebuilds after reorg', async () => {
    const previous = process.env.SOCIAL_GRAPH_V2_WORKER_ENABLED;
    process.env.SOCIAL_GRAPH_V2_WORKER_ENABLED = 'true';
    try {
      await db.query('TRUNCATE social_graph_v2_scopes');
      const reader: any = {
        identity: { network: scope.network, contract: scope.contract },
        verifyIdentity: jest.fn().mockResolvedValue(undefined),
        assertCanonical: jest.fn().mockResolvedValue(undefined),
        policy: jest.fn().mockResolvedValue({
          height: '100',
          block_hash: 'kh_start',
          importing: false,
        }),
        page: jest.fn().mockResolvedValue({
          network: scope.network,
          contract: scope.contract,
          block_hash: 'kh_start',
          items: [{ Follow: ['ak_a', 'ak_b'] }],
          next_cursor: null,
          end_cursor: '1',
        }),
        decodeLogs: jest.fn().mockResolvedValue([
          {
            index: 0,
            name: 'Unfollowed',
            changes: [{ ...edge, present: false }],
          },
        ]),
        countsAt: jest
          .fn()
          .mockResolvedValue({ followers: '0', following: '0', blocked: '0' }),
      };
      const node: any = {
        getKeyBlockByHeight: jest.fn().mockResolvedValue({
          hash: 'kh_end',
          height: 101,
          prevKeyHash: 'kh_start',
          prevHash: 'mh_one',
        }),
        getGenerationByHeight: jest.fn().mockResolvedValue({
          keyBlock: { hash: 'kh_start' },
          microBlocks: ['mh_one'],
        }),
        getMicroBlockHeaderByHash: jest.fn().mockResolvedValue({
          height: 100,
          prevHash: 'kh_start',
          prevKeyHash: 'kh_start',
        }),
        getMicroBlockTransactionsCountByHash: jest
          .fn()
          .mockResolvedValue({ count: 1 }),
        getMicroBlockTransactionByHashAndIndex: jest.fn().mockResolvedValue({
          hash: 'th_worker',
          blockHeight: 100,
          blockHash: 'mh_one',
          tx: { type: 'ContractCallTx' },
        }),
        getTransactionInfoByHash: jest
          .fn()
          .mockResolvedValue({ callInfo: { returnType: 'ok', log: [] } }),
      };
      const make = () =>
        new SocialGraphV2WorkerService(
          db,
          { sdk: { getContext: () => ({ onNode: node }) } } as any,
          { getReader: () => reader } as any,
          new SocialGraphV2SnapshotService(db, service),
          new SocialGraphV2CatchupService(db, service),
          new SocialGraphV2ReconcileService(db, service),
          service,
          new SocialGraphV2OutboxService(db, {
            emitAsync: async () => [true],
          } as any),
        );
      await make().tick(); // creates pinned snapshot
      await make().tick(); // completes one snapshot page
      reader.policy.mockResolvedValue({
        height: '102',
        block_hash: 'kh_tip',
        importing: false,
      });
      await make().tick(); // opens closed-generation window
      await make().tick(); // applies transaction and final checkpoint
      const queries = new SocialGraphV2QueryService(db);
      const ready = await queries.ready(scope.network, scope.contract);
      expect((await queries.counts(ready, 'ak_b')).followers).toBe('0');
      expect(
        await db.query('SELECT * FROM social_graph_v2_events'),
      ).toHaveLength(1);
      // A held session lock prevents another application instance from doing work.
      const lock = db.createQueryRunner();
      await lock.connect();
      try {
        await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
          `social-graph-v2:${scope.network}:${scope.contract}`,
        ]);
        reader.policy.mockClear();
        await make().tick();
        expect(reader.policy).not.toHaveBeenCalled();
      } finally {
        await lock.query('SELECT pg_advisory_unlock_all()');
        await lock.release();
      }
      reader.assertCanonical.mockRejectedValue(
        new Error('Snapshot is no longer canonical'),
      );
      await make().tick();
      await expect(
        queries.ready(scope.network, scope.contract),
      ).rejects.toThrow('not ready');
      reader.assertCanonical.mockResolvedValue(undefined);
      await make().tick();
      expect(
        await db.query(
          'SELECT generation,state FROM social_graph_v2_scopes ORDER BY generation',
        ),
      ).toEqual([
        { generation: '1', state: 'rebuilding' },
        { generation: '2', state: 'importing' },
      ]);
    } finally {
      if (previous === undefined)
        delete process.env.SOCIAL_GRAPH_V2_WORKER_ENABLED;
      else process.env.SOCIAL_GRAPH_V2_WORKER_ENABLED = previous;
    }
  });
  it('queues only actual live follows and retries scoped delivery without replay duplication', async () => {
    await db.query(
      'UPDATE social_graph_v2_scopes SET snapshot_height=100,notify_from_height=101',
    );
    const sync = new SocialGraphV2CatchupService(db, service);
    await sync.begin(scope, { hash: 'kh_history', height: '101' }, 'history');
    await sync.applyPage(scope, {
      expectedCursor: 'history',
      nextCursor: null,
      transactions: [
        {
          hash: 'th_history',
          height: '100',
          position: '1',
          events: [{ index: 0, changes: [edge] }],
        },
      ],
    });
    expect(await db.query('SELECT * FROM social_graph_v2_outbox')).toHaveLength(
      0,
    );
    await sync.begin(scope, { hash: 'kh_live', height: '102' }, 'live');
    const live = { ...edge, from: 'ak_c' };
    await sync.applyPage(scope, {
      expectedCursor: 'live',
      nextCursor: null,
      transactions: [
        {
          hash: 'th_live',
          height: '101',
          position: '2',
          events: [
            { index: 0, changes: [live] },
            { index: 1, changes: [live] },
          ],
        },
      ],
    });
    expect(await db.query('SELECT * FROM social_graph_v2_outbox')).toHaveLength(
      1,
    );
    const emitter: any = {
      emitAsync: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary delivery failure'))
        .mockResolvedValue([true]),
    };
    const outbox = new SocialGraphV2OutboxService(db, emitter);
    await outbox.dispatch(scope);
    expect(
      (await db.query('SELECT delivered FROM social_graph_v2_outbox'))[0]
        .delivered,
    ).toBe(false);
    await outbox.dispatch(scope);
    expect(emitter.emitAsync).toHaveBeenCalledTimes(1);
    await db.query(
      "UPDATE social_graph_v2_outbox SET next_attempt_at=now()-interval '1 second'",
    );
    await outbox.dispatch(scope);
    expect(emitter.emitAsync).toHaveBeenCalledTimes(2);
    expect(emitter.emitAsync.mock.calls[1][1].graphScope).toEqual({
      network: scope.network,
      contract: scope.contract,
      eventIndex: 0,
    });
    expect(
      (await db.query('SELECT delivered FROM social_graph_v2_outbox'))[0]
        .delivered,
    ).toBe(true);
  });
  it('does not dispatch outbox rows from an invalidated generation', async () => {
    await db.query(
      "INSERT INTO social_graph_v2_outbox(network,contract,generation,tx_hash,event_index,height,follower,followed) VALUES('ae_dev','ct_source',1,'th_old',0,100,'ak_a','ak_b')",
    );
    await service.invalidateAfterReorg(scope);
    const emitter: any = { emitAsync: jest.fn() };
    await new SocialGraphV2OutboxService(db, emitter).dispatch(scope);
    expect(emitter.emitAsync).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT delivered FROM social_graph_v2_outbox'))[0]
        .delivered,
    ).toBe(false);
  });

  it('keeps live reads consistent while indexing complete transactions within a generation', async () => {
    await db.query(
      "UPDATE social_graph_v2_scopes SET synced_hash='kh_ready',synced_height=100,snapshot_height=90",
    );
    const sync = new SocialGraphV2CatchupService(db, service),
      queries = new SocialGraphV2QueryService(db);
    await sync.begin(scope, { hash: 'kh_end', height: '101' }, 'live1');
    await sync.applyPage(scope, {
      expectedCursor: 'live1',
      nextCursor: 'live2',
      transactions: [
        {
          hash: 'th_liveprefix',
          height: '100',
          position: '1',
          events: [{ index: 0, changes: [edge] }],
        },
      ],
    });
    const ready = await queries.ready(scope.network, scope.contract);
    expect(await queries.counts(ready, 'ak_b')).toMatchObject({
      followers: '1',
      completed_height: '100',
      pending_height: '100',
      catching_up: true,
    });
    expect(
      (await queries.connections(ready, 'ak_b', 'followers', 20)).addresses,
    ).toEqual(['ak_a']);
    await sync.applyPage(scope, {
      expectedCursor: 'live2',
      nextCursor: null,
      transactions: [],
    });
    expect(await queries.counts(ready, 'ak_b')).toMatchObject({
      completed_height: '101',
      pending_height: null,
      catching_up: false,
    });
  });

  it('persists verified migration boundaries and never guesses from the projection snapshot', async () => {
    const target = { ...scope, generation: '2' },
      importer = new SocialGraphV2SnapshotService(db, service);
    const reader: any = {
      identity: scope,
      assertCanonical: async () => {},
      policy: async () => ({
        height: '120',
        block_hash: 'kh_snap',
        importing: false,
        import_source: 'ct_previous',
      }),
      migrationEvidence: jest
        .fn()
        .mockRejectedValueOnce(new Error('activation missing')),
    };
    await expect(importer.begin(target, reader)).rejects.toThrow(
      'activation missing',
    );
    expect(
      await db.query('SELECT * FROM social_graph_v2_scopes WHERE generation=2'),
    ).toHaveLength(0);
    reader.migrationEvidence.mockResolvedValue({
      sourceCutoff: '100',
      activationHeight: '110',
      proof: {
        kind: 'frozen-source',
        freeze_tx: 'th_freeze',
        activation_tx: 'th_activate',
      },
    });
    await importer.begin(target, reader);
    expect(
      await new SocialGraphV2QueryService(db).status(
        scope.network,
        scope.contract,
      ),
    ).toMatchObject({
      generation: '2',
      state: 'importing',
      snapshot_height: '120',
      source_cutoff: '100',
      activation_height: '110',
      migration_evidence: { kind: 'frozen-source' },
    });
  });
  it('rolls back and reapplies its isolated schema migration cleanly', async () => {
    const runner = db.createQueryRunner();
    try {
      const migration = new SocialGraphV2Projection1718900000035();
      await migration.down(runner);
      expect(
        (
          await runner.query(
            "SELECT to_regclass('social_graph_v2_scopes') AS name",
          )
        )[0].name,
      ).toBeNull();
      expect(
        (
          await runner.query(
            "SELECT to_regclass('social_graph_v2_outbox') AS name",
          )
        )[0].name,
      ).toBeNull();
      await migration.up(runner);
      expect(
        (
          await runner.query(
            "SELECT to_regclass('social_graph_v2_scopes') AS name",
          )
        )[0].name,
      ).toBe('social_graph_v2_scopes');
    } finally {
      await runner.release();
    }
  });
});

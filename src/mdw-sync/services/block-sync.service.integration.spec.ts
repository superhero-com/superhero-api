import 'dotenv/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { createEntityControllers } from '@/api-core/factories/entity-factory';
import { EntityConfig } from '@/api-core/types/entity-config.interface';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { fetchJson } from '@/utils/common';
import { ENTITY_CONFIGS } from '../config/entity-configs';
import { KeyBlock } from '../entities/key-block.entity';
import { PluginSyncState } from '../entities/plugin-sync-state.entity';
import { SyncState } from '../entities/sync-state.entity';
import { Tx } from '../entities/tx.entity';
import { SyncDirectionEnum } from '../types/sync-direction';
import { BlockSyncService } from './block-sync.service';
import { LiveIndexerService } from './live-indexer.service';

jest.mock('@/utils/common', () => ({
  ...jest.requireActual('@/utils/common'),
  fetchJson: jest.fn(),
}));

const d = process.env.DB_HOST ? describe : describe.skip;
const MDW = 'https://mdw.test';

const keyBlock = (height: number) => ({
  hash: `kh_${height}`,
  height,
  prev_hash: `mh_${height - 1}`,
  prev_key_hash: `kh_${height - 1}`,
  state_hash: `bs_${height}`,
  beneficiary: 'ak_beneficiary',
  miner: 'ak_miner',
  time: 1_700_000_000_000 + height,
  transactions_count: 1,
  micro_blocks_count: 3,
  beneficiary_reward: '0',
  flags: 'ba_flags',
  info: 'cb_info',
  nonce: 1,
  pow: [1, 2],
  target: 1,
  version: 6,
});

const middlewareTx = (height: number) => ({
  hash: `th_${height}`,
  block_height: height,
  block_hash: `mh_${height}`,
  micro_index: 0,
  micro_time: 1_700_000_000_000 + height,
  signatures: [],
  encoded_tx: `tx_${height}`,
  tx: { type: 'ContractCallTx', contract_id: 'ct_1', function: 'post' },
});

// Range sync, live sync and the retained routes must keep working once
// micro_blocks is gone, without asking the middleware for micro blocks.
d('Block sync without micro blocks (integration)', () => {
  let db: IsolatedDb;
  let processBatch: jest.Mock;
  let blockSync: BlockSyncService;

  const config = {
    get: (key: string, fallback?: unknown) =>
      key === 'mdw.middlewareUrl' ? MDW : fallback,
  };
  // The mock throws on these too, but a caller could swallow that error.
  const microBlockRequests = () =>
    (fetchJson as jest.Mock).mock.calls
      .map(([url]) => url as string)
      .filter((url) => url.includes('micro-blocks'));

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [KeyBlock, Tx, SyncState, PluginSyncState],
      migrations: [BaseSchema1718900000000],
    });
    await db.dataSource.runMigrations();
    await db.dataSource.query('DROP TABLE micro_blocks');
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.dataSource.query('DELETE FROM txs');
    await db.dataSource.query('DELETE FROM key_blocks');
    await db.dataSource.query('DELETE FROM sync_state');
    (fetchJson as jest.Mock).mockReset().mockImplementation(async (url) => {
      if (url.includes('micro-blocks')) {
        throw new Error(`micro-block endpoint requested: ${url}`);
      }
      if (url.startsWith(`${MDW}/v3/key-blocks?`)) {
        return { data: [keyBlock(100), keyBlock(101)], next: null };
      }
      if (url.startsWith(`${MDW}/v3/key-blocks/`)) {
        return keyBlock(Number(url.split('kh_')[1]));
      }
      // Two transaction pages, so validation-style hash collection pages too.
      if (url.includes('cursor=2')) {
        return { data: [middlewareTx(101)], next: null };
      }
      return {
        data: [middlewareTx(100)],
        next: '/v3/transactions?cursor=2',
      };
    });
    processBatch = jest.fn().mockResolvedValue(undefined);
    blockSync = new BlockSyncService(
      db.dataSource.getRepository(Tx),
      db.dataSource.getRepository(KeyBlock),
      config as any,
      {
        filterRelevantTransactions: (txs: Tx[]) => txs,
        processBatch,
      } as any,
    );
  });

  it('stores key blocks and every transaction page of a range, and re-syncs it idempotently', async () => {
    for (let run = 0; run < 2; run++) {
      await expect(blockSync.syncBlockRange(100, 101)).resolves.toEqual(
        new Map([
          [100, ['th_100']],
          [101, ['th_101']],
        ]),
      );
    }
    expect(microBlockRequests()).toEqual([]);

    const keyBlocks = await db.dataSource.query(
      'SELECT hash, height, micro_blocks_count FROM key_blocks ORDER BY height',
    );
    expect(keyBlocks).toEqual([
      { hash: 'kh_100', height: 100, micro_blocks_count: 3 },
      { hash: 'kh_101', height: 101, micro_blocks_count: 3 },
    ]);
    const txs = await db.dataSource.query(
      'SELECT hash, block_hash, block_height FROM txs ORDER BY block_height',
    );
    expect(txs).toEqual([
      { hash: 'th_100', block_hash: 'mh_100', block_height: 100 },
      { hash: 'th_101', block_hash: 'mh_101', block_height: 101 },
    ]);
    expect(processBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ hash: 'th_100' })],
      SyncDirectionEnum.Backward,
    );
  });

  it('backfills a range backward without collecting hashes', async () => {
    await expect(blockSync.syncBlockRange(100, 101, true)).resolves.toEqual(
      new Map(),
    );

    const urls = (fetchJson as jest.Mock).mock.calls.map(
      ([url]) => url as string,
    );
    expect(urls).toContainEqual(expect.stringContaining('direction=backward'));
    expect(microBlockRequests()).toEqual([]);
    await expect(
      db.dataSource.query('SELECT hash FROM txs ORDER BY block_height'),
    ).resolves.toEqual([{ hash: 'th_100' }, { hash: 'th_101' }]);
  });

  it('serves retained routes from synced rows and generates no micro-block route', async () => {
    await blockSync.syncBlockRange(100, 101);
    const moduleRef = await Test.createTestingModule({
      controllers: createEntityControllers(ENTITY_CONFIGS),
      providers: ENTITY_CONFIGS.map((entityConfig: EntityConfig) => ({
        provide: getRepositoryToken(entityConfig.entity),
        useValue: db.dataSource.getRepository(entityConfig.entity),
      })),
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const http = request(app.getHttpServer());

      const blocks = await http
        .get('/v2/mdw/key-blocks?includes=txs')
        .expect(200);
      expect(
        blocks.body.items.map((block: any) => [
          block.hash,
          block.txs.map((tx: any) => tx.hash),
        ]),
      ).toEqual([
        ['kh_101', ['th_101']],
        ['kh_100', ['th_100']],
      ]);

      const txs = await http.get('/v2/mdw/txs?includes=keyBlock').expect(200);
      expect(txs.body.items.map((tx: any) => tx.keyBlock.hash)).toEqual([
        'kh_101',
        'kh_100',
      ]);

      const stale = await http
        .get('/v2/mdw/key-blocks?includes=microBlocks')
        .expect(200);
      expect(stale.body.items[0]).not.toHaveProperty('microBlocks');

      await http
        .get('/v2/mdw/key-blocks?includes=txs.keyBlock.txs')
        .expect(400);
      await http.get('/v2/mdw/micro-blocks').expect(404);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('saves a live key block and advances the live height', async () => {
    await db.dataSource.query(
      `INSERT INTO sync_state (id, last_synced_height, last_synced_hash, tip_height)
       VALUES ('global', 0, '', 0)`,
    );
    const live = new LiveIndexerService(
      db.dataSource.getRepository(Tx),
      db.dataSource.getRepository(KeyBlock),
      db.dataSource.getRepository(SyncState),
      config as any,
      {} as any,
      {} as any,
      { emit: jest.fn() } as any,
    );
    const logged = jest.spyOn((live as any).logger, 'error');

    await live.handleKeyBlock({ hash: 'kh_102', height: 102 } as any);

    expect(logged).not.toHaveBeenCalled();
    expect(microBlockRequests()).toEqual([]);
    await expect(
      db.dataSource.query(
        `SELECT hash, height FROM key_blocks WHERE hash = 'kh_102'`,
      ),
    ).resolves.toEqual([{ hash: 'kh_102', height: 102 }]);
    await expect(
      db.dataSource.query(
        `SELECT live_synced_height, tip_height FROM sync_state WHERE id = 'global'`,
      ),
    ).resolves.toEqual([{ live_synced_height: 102, tip_height: 102 }]);
  });
});

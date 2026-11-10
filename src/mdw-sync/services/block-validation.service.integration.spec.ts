import 'dotenv/config';
import { BaseSchema1718900000000 } from '@/migrations/1718900000000-BaseSchema';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { fetchJson } from '@/utils/common';
import { KeyBlock } from '../entities/key-block.entity';
import { Tx } from '../entities/tx.entity';
import { SyncDirectionEnum } from '../types/sync-direction';
import { BlockSyncService } from './block-sync.service';
import { BlockValidationService } from './block-validation.service';

jest.mock('@/utils/common', () => ({
  ...jest.requireActual('@/utils/common'),
  fetchJson: jest.fn(),
}));

const d = process.env.DB_HOST ? describe : describe.skip;
const MDW = 'https://mdw.test';

const middlewareTx = (hash: string, height: number) => ({
  hash,
  block_height: height,
  block_hash: `mh_${height}`,
  micro_index: 0,
  micro_time: 1_700_000_000_000 + height,
  signatures: [],
  encoded_tx: `tx_${hash}`,
  tx: { type: 'ContractCallTx', contract_id: 'ct_1', function: 'post' },
});

d('Block validation sweep (integration)', () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [KeyBlock, Tx],
      migrations: [BaseSchema1718900000000],
    });
    await db.dataSource.runMigrations();
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  it('dispatches each tx once, after the reorg cleanup', async () => {
    const plugins = {
      filterRelevantTransactions: (txs: Tx[]) => txs,
      processBatch: jest.fn().mockResolvedValue(undefined),
      handleReorg: jest.fn().mockResolvedValue(undefined),
    };
    const settings: Record<string, unknown> = {
      'mdw.middlewareUrl': MDW,
      'mdw.reorgDepth': 1,
    };
    const config = {
      get: (key: string, fallback?: unknown) => settings[key] ?? fallback,
    };
    const txRepository = db.dataSource.getRepository(Tx);
    const blockSync = new BlockSyncService(
      txRepository,
      db.dataSource.getRepository(KeyBlock),
      config as any,
      plugins as any,
    );
    const validation = new BlockValidationService(
      txRepository,
      config as any,
      plugins as any,
      blockSync,
    );
    (fetchJson as jest.Mock).mockImplementation(async (url: string) => {
      if (url === `${MDW}/v3/status`) return { mdw_height: 101 };
      if (url.includes('/v3/key-blocks')) return { data: [], next: null };
      // Two pages, so the refetch upserts (and used to dispatch) twice.
      if (url.includes('cursor=2')) {
        return { data: [middlewareTx('th_101', 101)], next: null };
      }
      return {
        data: [middlewareTx('th_100', 100)],
        next: '/v3/transactions?cursor=2',
      };
    });
    // Block 100 holds a tx that was forked away, and the live indexer missed
    // th_100, which replaced it.
    await blockSync.syncBlockRange(100, 101);
    await db.dataSource.query(
      `UPDATE txs SET hash = 'th_gone' WHERE hash = 'th_100'`,
    );
    plugins.processBatch.mockClear();

    await validation.validateAndRefreshBlocks();

    await expect(
      db.dataSource.query('SELECT hash FROM txs ORDER BY hash'),
    ).resolves.toEqual([{ hash: 'th_100' }, { hash: 'th_101' }]);
    expect(plugins.handleReorg).toHaveBeenCalledTimes(1);
    expect(plugins.handleReorg).toHaveBeenCalledWith(['th_gone']);
    expect(
      plugins.processBatch.mock.calls.map(([txs, direction]) => [
        txs.map((tx: Tx) => tx.hash),
        direction,
      ]),
    ).toEqual([
      [['th_100'], SyncDirectionEnum.Backward],
      [['th_101'], SyncDirectionEnum.Backward],
    ]);
    expect(plugins.handleReorg.mock.invocationCallOrder[0]).toBeLessThan(
      plugins.processBatch.mock.invocationCallOrder[0],
    );
  });
});

// Mockable fetchJson while keeping the real URL-resolution + sanitize helpers.
const mockFetchJson = jest.fn();
jest.mock('@/utils/common', () => {
  const actual = jest.requireActual('@/utils/common');
  return {
    ...actual,
    fetchJson: (...args: any[]) => mockFetchJson(...args),
  };
});

import { SyncDirectionEnum } from '@/mdw-sync/types/sync-direction';

const KEY = 'SOCIAL_GRAPH_CONTRACT_ADDRESS';
// The mainnet identifiers from the bug report, so the page-shaped proof covers
// the exact tx that was missed.
const CONTRACT = 'ct_tC6G9MzysAvny8RBdq56oG3emgbUYEZhmfbaC3irfA8bbBJRS';
const MISSED_TX = 'th_23vadMrrvjpvN3D2bdKk9kFmom5F4FPMPRb6oqquDYLFko7Fi6';
const CALLER = 'ak_wqP6GiNVJeE6XyRGMjZE6Cq8rV6RRPbrVBr15TxB9GAFdqcph';

function loadService() {
  let SocialGraphBackfillService: any;
  jest.isolateModules(() => {
    SocialGraphBackfillService =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./social-graph-backfill.service').SocialGraphBackfillService;
  });
  return SocialGraphBackfillService;
}

function rawContractCallTx(hash: string) {
  return {
    hash,
    block_height: 1352517,
    block_hash: 'mh_1',
    micro_index: 0,
    micro_time: 1700000000000,
    encoded_tx: 'tx_encoded',
    signatures: ['sg_1'],
    tx: {
      type: 'ContractCallTx',
      contract_id: CONTRACT,
      caller_id: CALLER,
      log: [{ address: CONTRACT, topics: ['1', '2'], data: 'cb_' }],
    },
  };
}

describe('SocialGraphBackfillService', () => {
  const original = process.env[KEY];
  const configService = { get: () => 'https://mdw.example.com' } as any;

  beforeEach(() => {
    mockFetchJson.mockReset();
    process.env[KEY] = CONTRACT;
  });

  afterAll(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  it('saves the missed contract call (th_23vad…Fi6 @ 1352517) and replays it', async () => {
    mockFetchJson.mockResolvedValueOnce({
      data: [rawContractCallTx(MISSED_TX)],
      next: null,
    });
    const txRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest
        .fn()
        .mockImplementation((rows: any[]) => Promise.resolve(rows)),
    };
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };

    const Service = loadService();
    const service = new Service(configService, txRepo, plugin);
    const result = await service.backfill();

    expect(result).toEqual({ saved: 1, reprocessed: 1 });
    expect(txRepo.save).toHaveBeenCalledTimes(1);
    const saved = txRepo.save.mock.calls[0][0];
    expect(saved[0]).toMatchObject({
      hash: MISSED_TX,
      type: 'ContractCallTx',
      contract_id: CONTRACT,
      caller_id: CALLER,
      block_height: 1352517,
    });
    // The tx object (with its log) is preserved for the plugin to decode edges.
    expect(saved[0].raw.log[0].topics).toEqual(['1', '2']);
    expect(plugin.processBatch).toHaveBeenCalledWith(
      saved,
      SyncDirectionEnum.Backward,
    );
  });

  it('reprocesses a tx already stored (does not skip it) so a zero-edge row is recovered', async () => {
    mockFetchJson.mockResolvedValueOnce({
      data: [rawContractCallTx(MISSED_TX)],
      next: null,
    });
    // Already in the DB with its log intact — nothing to save, but it must be
    // reprocessed, because it was stored before the decode fix and has no edge.
    const storedRow = {
      hash: MISSED_TX,
      raw: { log: [{ address: CONTRACT, topics: ['1', '2'] }] },
    };
    const txRepo = {
      find: jest.fn().mockResolvedValue([storedRow]),
      save: jest.fn(),
    };
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };

    const Service = loadService();
    const service = new Service(configService, txRepo, plugin);
    const result = await service.backfill();

    expect(result).toEqual({ saved: 0, reprocessed: 1 });
    expect(txRepo.save).not.toHaveBeenCalled();
    expect(plugin.processBatch).toHaveBeenCalledWith(
      [storedRow],
      SyncDirectionEnum.Backward,
    );
  });

  it('refreshes raw from the payload when a stored row lost its log, then reprocesses', async () => {
    mockFetchJson.mockResolvedValueOnce({
      data: [rawContractCallTx(MISSED_TX)],
      next: null,
    });
    const storedRow: any = { hash: MISSED_TX, raw: null };
    const txRepo = {
      find: jest.fn().mockResolvedValue([storedRow]),
      save: jest
        .fn()
        .mockImplementation((rows: any[]) => Promise.resolve(rows)),
    };
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };

    const Service = loadService();
    const service = new Service(configService, txRepo, plugin);
    const result = await service.backfill();

    expect(result).toEqual({ saved: 0, reprocessed: 1 });
    // raw was refreshed from the middleware payload and persisted.
    expect(storedRow.raw.log[0].topics).toEqual(['1', '2']);
    expect(txRepo.save).toHaveBeenCalledWith([storedRow]);
    expect(plugin.processBatch).toHaveBeenCalledWith(
      [storedRow],
      SyncDirectionEnum.Backward,
    );
  });

  it('walks pages until the middleware stops returning a next link', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        data: [rawContractCallTx('th_a')],
        next: '/v3/transactions?cursor=2',
      })
      .mockResolvedValueOnce({ data: [rawContractCallTx('th_b')], next: null });
    const txRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest
        .fn()
        .mockImplementation((rows: any[]) => Promise.resolve(rows)),
    };
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };

    const Service = loadService();
    const service = new Service(configService, txRepo, plugin);
    const result = await service.backfill();

    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ saved: 2, reprocessed: 2 });
  });

  it('does not touch the middleware when the contract is unconfigured', () => {
    delete process.env[KEY];
    const txRepo = { find: jest.fn(), save: jest.fn() };
    const plugin = { processBatch: jest.fn() };

    const Service = loadService();
    const service = new Service(configService, txRepo, plugin);
    service.onModuleInit();

    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

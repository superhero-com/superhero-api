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

function rawContractCallTx(hash: string, blockHeight = 1352517) {
  return {
    hash,
    block_height: blockHeight,
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

// A state repo that persists in memory across "boots" so the watermark written
// by one backfill() run is visible to the next.
function makeStateRepo() {
  let row: any = null;
  return {
    findOne: jest.fn(async () => row),
    save: jest.fn(async (value: any) => {
      row = { ...value };
      return row;
    }),
    _current: () => row,
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

  it('recovers the missed contract call (th_23vad…Fi6 @ 1352517) and persists the watermark', async () => {
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
    const stateRepo = makeStateRepo();
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };

    const Service = loadService();
    const service = new Service(configService, txRepo, stateRepo, plugin);
    const result = await service.backfill();

    expect(result).toEqual({ saved: 1, reprocessed: 1 });
    const saved = txRepo.save.mock.calls[0][0];
    expect(saved[0]).toMatchObject({
      hash: MISSED_TX,
      contract_id: CONTRACT,
      caller_id: CALLER,
      block_height: 1352517,
    });
    expect(plugin.processBatch).toHaveBeenCalledWith(
      saved,
      SyncDirectionEnum.Backward,
    );
    // Watermark advanced to the highest recovered height.
    expect(stateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        contract_address: CONTRACT,
        last_backfilled_height: 1352517,
      }),
    );
  });

  it('recovers the three mainnet follows on the first boot and does not reprocess them on the second', async () => {
    const page = {
      // Newest-first, as direction=backward serves them.
      data: [
        rawContractCallTx('th_c', 1352517),
        rawContractCallTx('th_b', 1352514),
        rawContractCallTx('th_a', 1352513),
      ],
      next: null,
    };
    const txRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest
        .fn()
        .mockImplementation((rows: any[]) => Promise.resolve(rows)),
    };
    const stateRepo = makeStateRepo();
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };
    const Service = loadService();

    // First boot from the prod-bug state: all three recovered.
    mockFetchJson.mockResolvedValueOnce(page);
    const boot1 = await new Service(
      configService,
      txRepo,
      stateRepo,
      plugin,
    ).backfill();
    expect(boot1).toEqual({ saved: 3, reprocessed: 3 });
    expect(stateRepo._current().last_backfilled_height).toBe(1352517);

    // Second boot: same history from the middleware, but the watermark makes it
    // stop without reprocessing any already-recovered call.
    plugin.processBatch.mockClear();
    txRepo.save.mockClear();
    mockFetchJson.mockResolvedValueOnce(page);
    const boot2 = await new Service(
      configService,
      txRepo,
      stateRepo,
      plugin,
    ).backfill();
    expect(boot2).toEqual({ saved: 0, reprocessed: 0 });
    expect(plugin.processBatch).not.toHaveBeenCalled();
    expect(txRepo.save).not.toHaveBeenCalled();
    expect(stateRepo.save).toHaveBeenCalledTimes(1); // only boot1 advanced it
  });

  it('reprocesses a stored zero-event row (does not skip it) below the watermark on first boot', async () => {
    mockFetchJson.mockResolvedValueOnce({
      data: [rawContractCallTx(MISSED_TX)],
      next: null,
    });
    // Already in the DB with its log intact but decoded to []; must be
    // reprocessed so the edge is finally written.
    const storedRow = {
      hash: MISSED_TX,
      raw: { log: [{ address: CONTRACT, topics: ['1', '2'] }] },
      logs: { 'social-graph': { _version: 1, data: [] } },
    };
    const txRepo = {
      find: jest.fn().mockResolvedValue([storedRow]),
      save: jest.fn(),
    };
    const stateRepo = makeStateRepo();
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };

    const Service = loadService();
    const service = new Service(configService, txRepo, stateRepo, plugin);
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
    const stateRepo = makeStateRepo();
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };

    const Service = loadService();
    const service = new Service(configService, txRepo, stateRepo, plugin);
    const result = await service.backfill();

    expect(result).toEqual({ saved: 0, reprocessed: 1 });
    expect(storedRow.raw.log[0].topics).toEqual(['1', '2']);
    expect(txRepo.save).toHaveBeenCalledWith([storedRow]);
    expect(plugin.processBatch).toHaveBeenCalledWith(
      [storedRow],
      SyncDirectionEnum.Backward,
    );
  });

  it('does not advance the watermark when the walk is truncated by the page cap', async () => {
    // Every page returns a full page and another next link, so the walk never
    // reaches the end within PAGE_SAFETY; a partial run must not mark done.
    mockFetchJson.mockImplementation(async () => ({
      data: [rawContractCallTx('th_x')],
      next: '/v3/transactions?cursor=more',
    }));
    const txRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest
        .fn()
        .mockImplementation((rows: any[]) => Promise.resolve(rows)),
    };
    const stateRepo = makeStateRepo();
    const plugin = {
      processBatch: jest.fn().mockResolvedValue({ failed: [] }),
    };

    const Service = loadService();
    const service = new Service(configService, txRepo, stateRepo, plugin);
    await service.backfill();

    expect(stateRepo.save).not.toHaveBeenCalled();
  });

  it('does not touch the middleware when the contract is unconfigured', () => {
    delete process.env[KEY];
    const txRepo = { find: jest.fn(), save: jest.fn() };
    const stateRepo = makeStateRepo();
    const plugin = { processBatch: jest.fn() };

    const Service = loadService();
    const service = new Service(configService, txRepo, stateRepo, plugin);
    service.onModuleInit();

    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

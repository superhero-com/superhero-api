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
      // No `function` — mirrors the payload that used to be dropped.
      caller_id: CALLER,
      log: [{ address: CONTRACT }],
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
      findOne: jest.fn().mockResolvedValue(null),
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

    expect(result).toEqual({ saved: 1, skipped: 0 });
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
    expect(saved[0].raw.log).toEqual([{ address: CONTRACT }]);
    expect(plugin.processBatch).toHaveBeenCalledWith(
      saved,
      SyncDirectionEnum.Backward,
    );
  });

  it('skips a tx already stored and never re-saves or re-processes it', async () => {
    mockFetchJson.mockResolvedValueOnce({
      data: [rawContractCallTx('th_present')],
      next: null,
    });
    const txRepo = {
      findOne: jest.fn().mockResolvedValue({ hash: 'th_present' }),
      save: jest.fn(),
    };
    const plugin = { processBatch: jest.fn() };

    const Service = loadService();
    const service = new Service(configService, txRepo, plugin);
    const result = await service.backfill();

    expect(result).toEqual({ saved: 0, skipped: 1 });
    expect(txRepo.save).not.toHaveBeenCalled();
    expect(plugin.processBatch).not.toHaveBeenCalled();
  });

  it('walks pages until the middleware stops returning a next link', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        data: [rawContractCallTx('th_a')],
        next: '/v3/transactions?cursor=2',
      })
      .mockResolvedValueOnce({ data: [rawContractCallTx('th_b')], next: null });
    const txRepo = {
      findOne: jest.fn().mockResolvedValue(null),
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
    expect(result).toEqual({ saved: 2, skipped: 0 });
  });

  it('does not touch the middleware when the contract is unconfigured', () => {
    delete process.env[KEY];
    const txRepo = { findOne: jest.fn(), save: jest.fn() };
    const plugin = { processBatch: jest.fn() };

    const Service = loadService();
    const service = new Service(configService, txRepo, plugin);
    service.onModuleInit();

    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

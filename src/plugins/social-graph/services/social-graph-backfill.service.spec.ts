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

    expect(result).toEqual({ saved: 1, reprocessed: 0 });
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
    expect(boot1).toEqual({ saved: 3, reprocessed: 0 });
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

  it('holds the watermark one below a tx whose replay failed, never at or past it', async () => {
    const page = {
      // Newest-first; the middle call fails replay.
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
      processBatch: jest.fn(async (txs: any[]) => ({
        failed: txs
          .filter((tx) => tx.block_height === 1352514)
          .map((tx) => ({ tx, error: new Error('replay failed') })),
      })),
    };

    const Service = loadService();
    mockFetchJson.mockResolvedValueOnce(page);
    await new Service(configService, txRepo, stateRepo, plugin).backfill();

    // Capped at failed_height - 1 (1352513), not the highest recovered (1352517).
    expect(stateRepo._current().last_backfilled_height).toBe(1352513);
  });

  it('re-walks the failed height and above on the next boot, keeping the recovered call below the watermark untouched', async () => {
    const page = {
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
    let failReplay = true;
    const plugin = {
      processBatch: jest.fn(async (txs: any[]) => ({
        failed: failReplay
          ? txs
              .filter((tx) => tx.block_height === 1352514)
              .map((tx) => ({ tx, error: new Error('replay failed') }))
          : [],
      })),
    };
    const Service = loadService();

    // Boot 1: th_b fails, watermark held at 1352513.
    mockFetchJson.mockResolvedValueOnce(page);
    await new Service(configService, txRepo, stateRepo, plugin).backfill();
    expect(stateRepo._current().last_backfilled_height).toBe(1352513);

    // Boot 2: replay now succeeds. th_a (<= watermark) is not re-walked; th_b
    // and th_c are, idempotently, and the watermark reaches the top.
    failReplay = false;
    plugin.processBatch.mockClear();
    mockFetchJson.mockResolvedValueOnce(page);
    const boot2 = await new Service(
      configService,
      txRepo,
      stateRepo,
      plugin,
    ).backfill();

    const rewalked = plugin.processBatch.mock.calls[0][0].map(
      (tx: any) => tx.hash,
    );
    expect(rewalked).toEqual(['th_c', 'th_b']);
    expect(boot2).toEqual({ saved: 2, reprocessed: 0 });
    expect(stateRepo._current().last_backfilled_height).toBe(1352517);
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

    // Watermark stays null (nothing marked done), but the resume state is
    // recorded so the next boot continues instead of restarting from the top.
    const state = stateRepo._current();
    expect(state.last_backfilled_height ?? null).toBeNull();
    expect(state.resume_from_height).toBe(1352517);
    expect(state.pending_high_height).toBe(1352517);
  });

  it('resumes a null-watermark history larger than the page-safety window and completes on a later boot', async () => {
    const TOP = 5100; // one call per page, > PAGE_SAFETY (50) pages of history
    const BOTTOM = 5041; // 60 distinct heights: boot 1 truncates, boot 2 finishes
    const heights = Array.from({ length: TOP - BOTTOM + 1 }, (_, i) => TOP - i);

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

    // Serve one contract call per page, newest-first, from the first height at
    // or below the resume ceiling the boot asked for; `next` is null only on the
    // last (oldest) page so an incomplete walk keeps a next link.
    const serveFrom = (ceiling: number) => {
      let idx = heights.findIndex((h) => h <= ceiling);
      if (idx < 0) idx = heights.length;
      mockFetchJson.mockImplementation(async () => {
        if (idx >= heights.length) {
          return { data: [], next: null };
        }
        const height = heights[idx];
        idx += 1;
        return {
          data: [rawContractCallTx(`th_${height}`, height)],
          next: idx < heights.length ? '/v3/transactions?cursor=more' : null,
        };
      });
    };

    // Boot 1: no watermark, walk from the newest page and truncate at the cap.
    serveFrom(Number.POSITIVE_INFINITY);
    const boot1 = await new Service(
      configService,
      txRepo,
      stateRepo,
      plugin,
    ).backfill();
    expect(boot1.saved).toBe(50); // exactly PAGE_SAFETY pages walked (all new)
    const afterBoot1 = stateRepo._current();
    expect(afterBoot1.last_backfilled_height ?? null).toBeNull();
    expect(afterBoot1.pending_high_height).toBe(TOP);
    expect(afterBoot1.resume_from_height).toBe(TOP - 49); // lowest height reached

    // Boot 2: resume below the truncation point, reach the oldest call, complete.
    serveFrom(afterBoot1.resume_from_height);
    const boot2 = await new Service(
      configService,
      txRepo,
      stateRepo,
      plugin,
    ).backfill();
    expect(boot2.saved).toBeGreaterThan(0);
    const oldestWalked = plugin.processBatch.mock.calls
      .flatMap((call: any[]) => call[0])
      .some((tx: any) => tx.block_height === BOTTOM);
    expect(oldestWalked).toBe(true);

    const afterBoot2 = stateRepo._current();
    // Walk complete: the carried top is promoted, resume state cleared.
    expect(afterBoot2.last_backfilled_height).toBe(TOP);
    expect(afterBoot2.resume_from_height).toBeNull();
    expect(afterBoot2.pending_high_height).toBeNull();
  });

  // saved and reprocessed must be disjoint: a tx is either newly persisted
  // (saved) or already stored and re-decoded (reprocessed), never both, so
  // saved + reprocessed is the number handed to the plugin with no double-count.
  describe('counter semantics (saved and reprocessed are disjoint)', () => {
    it('counts only-missing transactions as saved, reprocessed 0', async () => {
      mockFetchJson.mockResolvedValueOnce({
        data: [
          rawContractCallTx('th_new1', 1352517),
          rawContractCallTx('th_new2', 1352516),
        ],
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
      const result = await new Service(
        configService,
        txRepo,
        stateRepo,
        plugin,
      ).backfill();

      expect(result).toEqual({ saved: 2, reprocessed: 0 });
      expect(plugin.processBatch.mock.calls[0][0]).toHaveLength(2);
    });

    it('counts only-already-present transactions as reprocessed, saved 0', async () => {
      mockFetchJson.mockResolvedValueOnce({
        data: [
          rawContractCallTx('th_old1', 1352517),
          rawContractCallTx('th_old2', 1352516),
        ],
        next: null,
      });
      const txRepo = {
        find: jest.fn().mockResolvedValue([
          { hash: 'th_old1', raw: { log: [{ topics: ['1', '2'] }] } },
          { hash: 'th_old2', raw: { log: [{ topics: ['1', '2'] }] } },
        ]),
        save: jest.fn(),
      };
      const stateRepo = makeStateRepo();
      const plugin = {
        processBatch: jest.fn().mockResolvedValue({ failed: [] }),
      };

      const Service = loadService();
      const result = await new Service(
        configService,
        txRepo,
        stateRepo,
        plugin,
      ).backfill();

      expect(result).toEqual({ saved: 0, reprocessed: 2 });
      expect(txRepo.save).not.toHaveBeenCalled();
      expect(plugin.processBatch.mock.calls[0][0]).toHaveLength(2);
    });

    it('splits a mixed page: new to saved, stored to reprocessed, all handed to the plugin', async () => {
      mockFetchJson.mockResolvedValueOnce({
        data: [
          rawContractCallTx('th_new1', 1352517),
          rawContractCallTx('th_old1', 1352516),
          rawContractCallTx('th_new2', 1352515),
          rawContractCallTx('th_old2', 1352514),
        ],
        next: null,
      });
      const txRepo = {
        find: jest.fn().mockResolvedValue([
          { hash: 'th_old1', raw: { log: [{ topics: ['1', '2'] }] } },
          { hash: 'th_old2', raw: { log: [{ topics: ['1', '2'] }] } },
        ]),
        save: jest
          .fn()
          .mockImplementation((rows: any[]) => Promise.resolve(rows)),
      };
      const stateRepo = makeStateRepo();
      const plugin = {
        processBatch: jest.fn().mockResolvedValue({ failed: [] }),
      };

      const Service = loadService();
      const result = await new Service(
        configService,
        txRepo,
        stateRepo,
        plugin,
      ).backfill();

      expect(result).toEqual({ saved: 2, reprocessed: 2 });
      // Disjoint and complete: every walked tx reached the plugin exactly once.
      const handed = plugin.processBatch.mock.calls[0][0];
      expect(handed).toHaveLength(result.saved + result.reprocessed);
      expect(handed.map((tx: any) => tx.hash).sort()).toEqual([
        'th_new1',
        'th_new2',
        'th_old1',
        'th_old2',
      ]);
    });
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

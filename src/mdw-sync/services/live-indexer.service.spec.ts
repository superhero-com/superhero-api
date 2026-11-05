import { ITopHeader, ITransaction } from '@/utils/types';

jest.mock('@/utils/common', () => ({
  fetchJson: jest.fn(),
  sanitizeJsonForPostgres: jest.fn((value) => value),
}));

// Neutralise the websocket / sdk import chain. WebSocketService pulls in
// configs/nodes.ts which instantiates `new Node(...)` at module load time.
// We never exercise those code paths here, so stubbing the module keeps the
// test hermetic.
jest.mock('@/ae/websocket.service', () => ({
  WebSocketService: class {},
}));

jest.mock('@aeternity/aepp-sdk', () => ({
  // decode is only reached for SpendTx with a payload; return a plain buffer
  // so the tests can exercise that branch without real decoding.
  decode: jest.fn(() => Buffer.from('')),
  Node: class {},
  AeSdk: class {},
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { LiveIndexerService } = require('./live-indexer.service');
const { fetchJson } = require('@/utils/common');
/* eslint-enable @typescript-eslint/no-require-imports */

const MDW_URL = 'https://mdw.test/mdw';

const buildTransaction = (
  overrides: Partial<ITransaction['tx']> = {},
  hash = 'th_live_1',
): ITransaction =>
  ({
    hash,
    blockHeight: 500,
    blockHash: 'mh_live_1',
    microIndex: 0,
    microTime: 1700000000000,
    signatures: [],
    encodedTx: 'tx_live_1',
    pending: false,
    claim: null,
    tx: {
      type: 'ContractCallTx',
      contractId: 'ct_live',
      function: 'buy',
      callerId: 'ak_caller_live',
      ...overrides,
    },
  }) as unknown as ITransaction;

const setup = () => {
  const txRepository = {
    save: jest.fn(),
  } as any;
  const blockRepository = { upsert: jest.fn() } as any;
  const microBlockRepository = { upsert: jest.fn() } as any;
  const syncStateRepository = { update: jest.fn() } as any;
  const configService = {
    get: jest.fn((key: string) =>
      key === 'mdw.middlewareUrl' ? MDW_URL : undefined,
    ),
  } as any;
  const unsubscribeTransactions = jest.fn();
  const unsubscribeKeyBlocks = jest.fn();
  const websocketService = {
    subscribeForTransactionsUpdates: jest.fn(() => unsubscribeTransactions),
    subscribeForKeyBlocksUpdates: jest.fn(() => unsubscribeKeyBlocks),
  } as any;
  const pluginBatchProcessor = {
    isRelevantTransaction: jest.fn(),
    processBatch: jest.fn(),
  } as any;
  const microBlockService = {
    fetchMicroBlocksForKeyBlock: jest.fn().mockResolvedValue([]),
  } as any;
  const eventEmitter = { emit: jest.fn() } as any;

  const service = new LiveIndexerService(
    txRepository,
    blockRepository,
    microBlockRepository,
    syncStateRepository,
    configService,
    websocketService,
    pluginBatchProcessor,
    microBlockService,
    eventEmitter,
  );
  const loggerError = jest
    .spyOn((service as any).logger, 'error')
    .mockImplementation(() => undefined);
  jest
    .spyOn((service as any).logger, 'log')
    .mockImplementation(() => undefined);

  return {
    service,
    txRepository,
    blockRepository,
    microBlockRepository,
    syncStateRepository,
    websocketService,
    unsubscribeTransactions,
    unsubscribeKeyBlocks,
    pluginBatchProcessor,
    microBlockService,
    eventEmitter,
    loggerError,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * Covers the live ingestion path. The critical behaviour we lock down here is
 * the plugin-relevance gate in `handleLiveTransaction`:
 *   - irrelevant transactions must never reach the DB or the plugin pipeline;
 *   - relevant transactions must go through repository.save + processBatch.
 */
describe('LiveIndexerService.handleLiveTransaction', () => {
  it('skips irrelevant transactions before touching the database', async () => {
    const { service, txRepository, pluginBatchProcessor } = setup();
    pluginBatchProcessor.isRelevantTransaction.mockReturnValue(false);

    await service.handleLiveTransaction(buildTransaction());

    expect(pluginBatchProcessor.isRelevantTransaction).toHaveBeenCalledTimes(1);
    expect(txRepository.save).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.processBatch).not.toHaveBeenCalled();
  });

  it('emits the live-tx event for cross-cutting consumers, even when irrelevant', async () => {
    // The notification trigger relies on this firing BEFORE the relevance gate,
    // so transfers we never persist still surface to listeners.
    const { service, eventEmitter, pluginBatchProcessor } = setup();
    pluginBatchProcessor.isRelevantTransaction.mockReturnValue(false);

    await service.handleLiveTransaction(
      buildTransaction({ type: 'SpendTx', recipientId: 'ak_recipient' }),
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'chain.tx.live',
      expect.objectContaining({ hash: 'th_live_1', type: 'SpendTx' }),
    );
  });

  it('passes the mdw-shaped tx (not the raw websocket shape) to the relevance gate', async () => {
    // Regression guard: the predicate must see the same `Partial<Tx>` shape
    // the backward sync uses, otherwise plugin filters that inspect
    // `contract_id` / `function` silently stop matching on the live path.
    const { service, pluginBatchProcessor } = setup();
    pluginBatchProcessor.isRelevantTransaction.mockReturnValue(false);

    await service.handleLiveTransaction(
      buildTransaction({
        type: 'ContractCallTx',
        contractId: 'ct_bcl',
        function: 'buy',
      }),
    );

    expect(pluginBatchProcessor.isRelevantTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: 'th_live_1',
        type: 'ContractCallTx',
        contract_id: 'ct_bcl',
        function: 'buy',
      }),
    );
  });

  it('persists the transaction and forwards it to processBatch when relevant', async () => {
    const { service, txRepository, pluginBatchProcessor } = setup();
    pluginBatchProcessor.isRelevantTransaction.mockReturnValue(true);
    txRepository.save.mockResolvedValueOnce({
      hash: 'th_live_1',
      block_height: 500,
      type: 'ContractCallTx',
    });

    await service.handleLiveTransaction(buildTransaction());

    expect(txRepository.save).toHaveBeenCalledTimes(1);
    expect(pluginBatchProcessor.processBatch).toHaveBeenCalledTimes(1);
    expect(pluginBatchProcessor.processBatch).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          hash: 'th_live_1',
          block_height: 500,
        }),
      ],
      'live',
    );
  });

  it('swallows DB errors so a single bad tx cannot kill the websocket handler', async () => {
    const { service, txRepository, pluginBatchProcessor, loggerError } =
      setup();

    pluginBatchProcessor.isRelevantTransaction.mockReturnValue(true);
    txRepository.save.mockRejectedValueOnce(new Error('db is down'));

    await expect(
      service.handleLiveTransaction(buildTransaction()),
    ).resolves.toBeUndefined();

    expect(pluginBatchProcessor.processBatch).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      'Failed to handle live transaction',
      expect.any(Error),
    );
  });
});

describe('LiveIndexerService websocket subscriptions', () => {
  const subscribe = () => {
    const ctx = setup();
    const handleLiveTransaction = jest
      .spyOn(ctx.service, 'handleLiveTransaction')
      .mockResolvedValue(undefined);
    const handleKeyBlock = jest
      .spyOn(ctx.service, 'handleKeyBlock')
      .mockResolvedValue(undefined);
    ctx.service.onModuleInit();
    const [onTransaction] =
      ctx.websocketService.subscribeForTransactionsUpdates.mock.calls[0];
    const [onKeyBlock] =
      ctx.websocketService.subscribeForKeyBlocksUpdates.mock.calls[0];
    return {
      ...ctx,
      handleLiveTransaction,
      handleKeyBlock,
      onTransaction: onTransaction as (tx: ITransaction) => void,
      onKeyBlock: onKeyBlock as (header: ITopHeader) => void,
    };
  };

  const handledHashes = (spy: jest.SpyInstance) =>
    spy.mock.calls.map(([tx]) => tx.hash);

  it('is inactive until both channels are subscribed, and unsubscribes both on destroy', () => {
    const ctx = setup();
    expect(ctx.service.getIsActive()).toBe(false);

    ctx.service.onModuleInit();
    expect(ctx.service.getIsActive()).toBe(true);

    ctx.service.onModuleDestroy();
    expect(ctx.unsubscribeTransactions).toHaveBeenCalledTimes(1);
    expect(ctx.unsubscribeKeyBlocks).toHaveBeenCalledTimes(1);
  });

  it('does not throw on destroy when it never subscribed', () => {
    const { service } = setup();
    expect(() => service.onModuleDestroy()).not.toThrow();
  });

  it('routes every key-block header to handleKeyBlock', () => {
    const { onKeyBlock, handleKeyBlock } = subscribe();
    const header = { hash: 'kh_1', height: 10 } as ITopHeader;

    onKeyBlock(header);

    expect(handleKeyBlock).toHaveBeenCalledWith(header);
  });

  it('handles a hash the websocket delivers twice only once', () => {
    const { onTransaction, handleLiveTransaction } = subscribe();

    onTransaction(buildTransaction({}, 'th_a'));
    onTransaction(buildTransaction({}, 'th_b'));
    onTransaction(buildTransaction({}, 'th_a'));

    expect(handledHashes(handleLiveTransaction)).toEqual(['th_a', 'th_b']);
  });

  it('ignores self-transfers', () => {
    const { onTransaction, handleLiveTransaction } = subscribe();

    onTransaction(
      buildTransaction(
        { type: 'SpendTx', senderId: 'ak_same', recipientId: 'ak_same' },
        'th_self',
      ),
    );
    onTransaction(
      buildTransaction(
        { type: 'SpendTx', senderId: 'ak_from', recipientId: 'ak_to' },
        'th_spend',
      ),
    );

    expect(handledHashes(handleLiveTransaction)).toEqual(['th_spend']);
  });

  it('forgets the oldest hashes once more than 100 have been seen, so memory stays bounded', () => {
    const { onTransaction, handleLiveTransaction } = subscribe();

    for (let i = 0; i <= 100; i++) {
      onTransaction(buildTransaction({}, `th_${i}`));
    }
    onTransaction(buildTransaction({}, 'th_0'));

    expect(handleLiveTransaction).toHaveBeenCalledTimes(102);
    expect(handledHashes(handleLiveTransaction).at(-1)).toBe('th_0');
  });

  it('still drops resends of the latest 100 hashes after the oldest one is forgotten', () => {
    const { onTransaction, handleLiveTransaction } = subscribe();

    for (let i = 0; i <= 100; i++) {
      onTransaction(buildTransaction({}, `th_${i}`));
    }
    onTransaction(buildTransaction({}, 'th_100'));
    onTransaction(buildTransaction({}, 'th_1'));

    expect(handleLiveTransaction).toHaveBeenCalledTimes(101);
  });
});

describe('LiveIndexerService.handleKeyBlock', () => {
  const header = { hash: 'kh_live', height: 900 } as ITopHeader;
  const fullBlock = {
    hash: 'kh_live',
    height: 900,
    time: 1700000000000,
    prev_hash: 'kh_prev',
    prev_key_hash: 'kh_prev',
    beneficiary: 'ak_beneficiary',
    miner: 'ak_miner',
    info: 'cb_info',
    flags: 'ba_flags',
  };
  const microBlocks = [
    { hash: 'mh_1', height: 900 },
    { hash: 'mh_2', height: 900 },
  ];

  it('upserts the full key block by height, advances the sync state, then stores its micro-blocks', async () => {
    const ctx = setup();
    fetchJson.mockResolvedValueOnce(fullBlock);
    ctx.microBlockService.fetchMicroBlocksForKeyBlock.mockResolvedValueOnce(
      microBlocks,
    );

    await ctx.service.handleKeyBlock(header);

    expect(fetchJson).toHaveBeenCalledWith(`${MDW_URL}/v3/key-blocks/kh_live`);
    // Exact options: skipUpdateIfNoValuesChanged makes Postgres compare jsonb
    // with "=", which it cannot do.
    expect(ctx.blockRepository.upsert).toHaveBeenCalledWith(
      { ...fullBlock, created_at: new Date(1700000000000) },
      { conflictPaths: ['height'] },
    );
    expect(ctx.syncStateRepository.update).toHaveBeenCalledWith(
      { id: 'global' },
      { live_synced_height: 900, tip_height: 900 },
    );
    expect(
      ctx.microBlockService.fetchMicroBlocksForKeyBlock,
    ).toHaveBeenCalledWith('kh_live');
    expect(ctx.microBlockRepository.upsert).toHaveBeenCalledWith(microBlocks, {
      conflictPaths: ['hash'],
      skipUpdateIfNoValuesChanged: true,
    });
    expect(ctx.blockRepository.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.syncStateRepository.update.mock.invocationCallOrder[0],
    );
    expect(ctx.loggerError).not.toHaveBeenCalled();
  });

  it('skips the micro-block upsert when the key block has none', async () => {
    const ctx = setup();
    fetchJson.mockResolvedValueOnce(fullBlock);

    await ctx.service.handleKeyBlock(header);

    expect(ctx.syncStateRepository.update).toHaveBeenCalledTimes(1);
    expect(ctx.microBlockRepository.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the MDW request fails',
      () => fetchJson.mockRejectedValueOnce(new Error('502')),
    ],
    [
      'MDW answers 204 (fetchJson returns null)',
      () => fetchJson.mockResolvedValueOnce(null),
    ],
  ])('does not advance the live height when %s', async (_label, arrange) => {
    const ctx = setup();
    arrange();

    await expect(ctx.service.handleKeyBlock(header)).resolves.toBeUndefined();

    expect(ctx.blockRepository.upsert).not.toHaveBeenCalled();
    expect(ctx.syncStateRepository.update).not.toHaveBeenCalled();
    expect(
      ctx.microBlockService.fetchMicroBlocksForKeyBlock,
    ).not.toHaveBeenCalled();
    expect(ctx.loggerError).toHaveBeenCalledWith(
      'Failed to handle key block kh_live',
      expect.any(Error),
    );
  });

  it('does not advance the live height when the key block cannot be saved', async () => {
    const ctx = setup();
    fetchJson.mockResolvedValueOnce(fullBlock);
    ctx.blockRepository.upsert.mockRejectedValueOnce(new Error('db is down'));

    await expect(ctx.service.handleKeyBlock(header)).resolves.toBeUndefined();

    expect(ctx.syncStateRepository.update).not.toHaveBeenCalled();
    expect(ctx.loggerError).toHaveBeenCalledWith(
      'Failed to handle key block kh_live',
      expect.any(Error),
    );
  });

  it.each([
    [
      'fetched',
      (ctx: ReturnType<typeof setup>) =>
        ctx.microBlockService.fetchMicroBlocksForKeyBlock.mockRejectedValueOnce(
          new Error('mdw timeout'),
        ),
    ],
    [
      'saved',
      (ctx: ReturnType<typeof setup>) => {
        ctx.microBlockService.fetchMicroBlocksForKeyBlock.mockResolvedValueOnce(
          microBlocks,
        );
        ctx.microBlockRepository.upsert.mockRejectedValueOnce(
          new Error('db is down'),
        );
      },
    ],
  ])(
    'keeps the saved key block when its micro-blocks cannot be %s',
    async (_label, arrange) => {
      const ctx = setup();
      fetchJson.mockResolvedValueOnce(fullBlock);
      arrange(ctx);

      await expect(ctx.service.handleKeyBlock(header)).resolves.toBeUndefined();

      expect(ctx.blockRepository.upsert).toHaveBeenCalledTimes(1);
      expect(ctx.syncStateRepository.update).toHaveBeenCalledTimes(1);
      expect(ctx.loggerError).toHaveBeenCalledWith(
        'Failed to fetch micro-blocks for key block kh_live',
        expect.any(Error),
      );
      expect(ctx.loggerError).not.toHaveBeenCalledWith(
        'Failed to handle key block kh_live',
        expect.anything(),
      );
    },
  );
});

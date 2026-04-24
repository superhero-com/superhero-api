import { ITransaction } from '@/utils/types';

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LiveIndexerService } = require('./live-indexer.service');

/**
 * Covers the live ingestion path. The critical behaviour we lock down here is
 * the plugin-relevance gate in `handleLiveTransaction`:
 *   - irrelevant transactions must never reach the DB or the plugin pipeline;
 *   - relevant transactions must go through repository.save + processBatch.
 */
describe('LiveIndexerService.handleLiveTransaction', () => {
  const buildTransaction = (
    overrides: Partial<ITransaction['tx']> = {},
  ): ITransaction =>
    ({
      hash: 'th_live_1',
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
    const configService = { get: jest.fn() } as any;
    const websocketService = {
      subscribeForTransactionsUpdates: jest.fn(() => () => undefined),
      subscribeForKeyBlocksUpdates: jest.fn(() => () => undefined),
    } as any;
    const pluginBatchProcessor = {
      isRelevantTransaction: jest.fn(),
      processBatch: jest.fn(),
    } as any;
    const microBlockService = {
      fetchMicroBlocksForKeyBlock: jest.fn(),
    } as any;

    const service = new LiveIndexerService(
      txRepository,
      blockRepository,
      microBlockRepository,
      syncStateRepository,
      configService,
      websocketService,
      pluginBatchProcessor,
      microBlockService,
    );

    return {
      service,
      txRepository,
      pluginBatchProcessor,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips irrelevant transactions before touching the database', async () => {
    const { service, txRepository, pluginBatchProcessor } = setup();
    pluginBatchProcessor.isRelevantTransaction.mockReturnValue(false);

    await service.handleLiveTransaction(buildTransaction());

    expect(pluginBatchProcessor.isRelevantTransaction).toHaveBeenCalledTimes(1);
    expect(txRepository.save).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.processBatch).not.toHaveBeenCalled();
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
    const { service, txRepository, pluginBatchProcessor } = setup();
    const loggerError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

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

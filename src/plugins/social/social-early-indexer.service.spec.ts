import { fetchJson, FetchJsonHttpError } from '@/utils/common';
import { PostTypeDetectionService } from './services/post-type-detection.service';

jest.mock('@/utils/common', () => ({
  ...jest.requireActual('@/utils/common'),
  fetchJson: jest.fn(),
}));

// WebSocketService pulls in configs/nodes.ts, which builds an sdk Node at load.
jest.mock('@/ae/websocket.service', () => ({
  WebSocketService: class {},
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SocialEarlyIndexerService } = require('./social-early-indexer.service');

const CONTRACT = 'ct_post';
const fetchJsonMock = fetchJson as jest.Mock;

const nodeTx = (hash: string, tx: Record<string, unknown> = {}) =>
  ({
    hash,
    tx: { type: 'ContractCallTx', contractId: CONTRACT, ...tx },
  }) as any;

const mdwTx = (hash: string, media: string[] = []) => ({
  hash,
  block_hash: 'mh_1',
  block_height: 1,
  micro_index: 0,
  micro_time: 1700000000000,
  signatures: [],
  encoded_tx: 'tx_1',
  tx: {
    type: 'ContractCallTx',
    contract_id: CONTRACT,
    caller_id: 'ak_1',
    function: 'post_without_tip',
    arguments: [
      { type: 'string', value: 'hello' },
      { type: 'list', value: media.map((value) => ({ value })) },
    ],
    return: { type: 'int', value: 1 },
  },
});

const notFound = () => new FetchJsonHttpError('not found', 404);

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('SocialEarlyIndexerService', () => {
  const env = { ...process.env };

  const setup = (contracts = [{ contractAddress: CONTRACT, version: 3 }]) => {
    const postRepository = { exists: jest.fn().mockResolvedValue(true) };
    const unsubscribe = jest.fn();
    let push: (transaction: any) => void = () => undefined;
    const websocketService = {
      subscribeForTransactionsUpdates: jest.fn(
        (callback: (transaction: any) => void) => {
          push = callback;
          return unsubscribe;
        },
      ),
    };
    const configService = { get: jest.fn(() => contracts) };
    const processor = {
      processTransaction: jest.fn(async (tx: any) => ({
        post: { id: `${tx.hash}_post` },
        success: true,
        skipped: false,
      })),
    };
    const service = new SocialEarlyIndexerService(
      postRepository,
      websocketService,
      configService,
      new PostTypeDetectionService(),
      processor,
    );
    service.onModuleInit();
    return {
      service,
      push: (transaction: any) => push(transaction),
      postRepository,
      websocketService,
      processor,
      unsubscribe,
    };
  };

  beforeEach(() => {
    delete process.env.DISABLE_MDW_SYNC;
    delete process.env.SOCIAL_EARLY_INDEXING_ENABLED;
    fetchJsonMock.mockReset();
    fetchJsonMock.mockImplementation(async (url: string) =>
      mdwTx(url.split('/').pop()),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  it('subscribes to node-source transactions', () => {
    const { websocketService } = setup();

    expect(
      websocketService.subscribeForTransactionsUpdates,
    ).toHaveBeenCalledWith(expect.any(Function), 'node');
  });

  it.each([
    ['SOCIAL_EARLY_INDEXING_ENABLED', 'false'],
    ['DISABLE_MDW_SYNC', 'true'],
  ])('stays off when %s=%s', (name, value) => {
    process.env[name] = value;

    const { websocketService } = setup();

    expect(
      websocketService.subscribeForTransactionsUpdates,
    ).not.toHaveBeenCalled();
  });

  it('stays off when no post contracts are configured', () => {
    const { websocketService } = setup([]);

    expect(
      websocketService.subscribeForTransactionsUpdates,
    ).not.toHaveBeenCalled();
  });

  it('ignores calls to other contracts and other transaction types', async () => {
    const { push, processor } = setup();

    push(nodeTx('th_other', { contractId: 'ct_other' }));
    push(nodeTx('th_spend', { type: 'SpendTx' }));
    await flush();

    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(processor.processTransaction).not.toHaveBeenCalled();
  });

  it('processes a post-contract call in live mode with MDW data', async () => {
    const { push, processor } = setup();

    push(nodeTx('th_1'));
    push(nodeTx('th_1'));
    await flush();

    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    expect(fetchJsonMock.mock.calls[0][0]).toMatch(/\/v3\/transactions\/th_1$/);
    expect(processor.processTransaction).toHaveBeenCalledTimes(1);
    expect(processor.processTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: 'th_1',
        contract_id: CONTRACT,
        block_hash: 'mh_1',
        micro_time: '1700000000000',
      }),
      'live',
    );
  });

  it('retries a 404 every 2s, then processes', async () => {
    jest.useFakeTimers();
    const { push, processor } = setup();
    fetchJsonMock
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound());

    push(nodeTx('th_1'));
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    expect(processor.processTransaction).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(4_000);

    expect(fetchJsonMock).toHaveBeenCalledTimes(3);
    expect(processor.processTransaction).toHaveBeenCalledTimes(1);
  });

  it('gives up after 90s and moves on to the next transaction', async () => {
    jest.useFakeTimers();
    const { push, processor } = setup();
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.endsWith('th_missing')) throw notFound();
      return mdwTx(url.split('/').pop());
    });

    push(nodeTx('th_missing'));
    push(nodeTx('th_next'));
    await jest.advanceTimersByTimeAsync(88_000);
    expect(processor.processTransaction).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(4_000);

    const missingCalls = fetchJsonMock.mock.calls.filter(([url]) =>
      url.endsWith('th_missing'),
    );
    expect(missingCalls).toHaveLength(46);
    expect(processor.processTransaction).toHaveBeenCalledTimes(1);
    expect(processor.processTransaction.mock.calls[0][0].hash).toBe('th_next');
  });

  it('processes one transaction at a time in arrival order', async () => {
    const { push, processor } = setup();
    let releaseFirst: () => void;
    processor.processTransaction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ post: { id: 'p' }, success: true, skipped: false });
        }),
    );

    push(nodeTx('th_1'));
    push(nodeTx('th_2'));
    push(nodeTx('th_3'));
    await flush();
    expect(processor.processTransaction).toHaveBeenCalledTimes(1);

    releaseFirst();
    await flush();

    expect(
      processor.processTransaction.mock.calls.map(([tx]) => tx.hash),
    ).toEqual(['th_1', 'th_2', 'th_3']);
  });

  it('skips replies whose parent is not indexed yet', async () => {
    const { push, postRepository, processor } = setup();
    postRepository.exists.mockResolvedValue(false);
    fetchJsonMock.mockResolvedValue(mdwTx('th_reply', ['comment:5']));

    push(nodeTx('th_reply'));
    await flush();

    expect(postRepository.exists).toHaveBeenCalledWith({
      where: { id: '5_v3' },
    });
    expect(processor.processTransaction).not.toHaveBeenCalled();
  });

  it('indexes replies whose parent is already indexed', async () => {
    const { push, processor } = setup();
    fetchJsonMock.mockResolvedValue(mdwTx('th_reply', ['comment:5']));

    push(nodeTx('th_reply'));
    await flush();

    expect(processor.processTransaction).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and drops queued work on shutdown', async () => {
    const { service, push, processor, unsubscribe } = setup();

    push(nodeTx('th_1'));
    push(nodeTx('th_2'));
    service.onModuleDestroy();
    await flush();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(processor.processTransaction).not.toHaveBeenCalled();
    push(nodeTx('th_3'));
    await flush();
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['without a block hash', { block_hash: null }],
    ['for another hash', { hash: 'th_other' }],
  ])('keeps polling while MDW returns the tx %s', async (_, override) => {
    jest.useFakeTimers();
    const { push, processor } = setup();
    fetchJsonMock.mockResolvedValueOnce({ ...mdwTx('th_1'), ...override });

    push(nodeTx('th_1'));
    await jest.advanceTimersByTimeAsync(0);
    expect(processor.processTransaction).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2_000);

    expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    expect(processor.processTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'th_1', block_hash: 'mh_1' }),
      'live',
    );
  });

  it('moves on when indexing a transaction throws', async () => {
    const { push, postRepository, processor } = setup();
    postRepository.exists.mockRejectedValueOnce(new Error('db down'));
    fetchJsonMock.mockImplementation(async (url: string) => {
      const hash = url.split('/').pop();
      return mdwTx(hash, hash === 'th_reply' ? ['comment:5'] : []);
    });

    push(nodeTx('th_reply'));
    push(nodeTx('th_next'));
    await flush();

    expect(
      processor.processTransaction.mock.calls.map(([tx]) => tx.hash),
    ).toEqual(['th_next']);
  });

  it('leaves transactions to MDW while the queue is full', async () => {
    const { push, processor } = setup();
    processor.processTransaction.mockResolvedValue({
      post: null,
      success: false,
      skipped: true,
    });
    let releaseFirst: () => void;
    fetchJsonMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(mdwTx('th_0'));
        }),
    );

    // th_0 is in flight, th_1..th_100 fill the queue, th_101 does not fit.
    for (let i = 0; i <= 101; i++) {
      push(nodeTx(`th_${i}`));
    }
    releaseFirst();
    await flush();

    const processed = processor.processTransaction.mock.calls.map(
      ([tx]) => tx.hash,
    );
    expect(processed).toHaveLength(101);
    expect(processed).not.toContain('th_101');
  });
});

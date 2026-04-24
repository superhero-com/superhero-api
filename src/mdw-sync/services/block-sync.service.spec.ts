import { ConfigService } from '@nestjs/config';
import { BlockSyncService } from './block-sync.service';
import { fetchJson } from '@/utils/common';

jest.mock('@/utils/common', () => ({
  fetchJson: jest.fn(),
  sanitizeJsonForPostgres: jest.fn((value) => value),
}));

describe('BlockSyncService', () => {
  const buildMiddlewareTransaction = () => ({
    hash: 'th_test_1',
    block_height: 123,
    block_hash: 'mh_test_1',
    micro_index: 1,
    micro_time: 1700000000000,
    signatures: [],
    encoded_tx: 'tx_test_1',
    tx: {
      type: 'ContractCallTx',
      contract_id: 'ct_test_1',
      function: 'transfer',
      caller_id: 'ak_caller_1',
    },
  });

  const setup = () => {
    const txRepository = {
      save: jest.fn(),
      upsert: jest.fn(),
      find: jest.fn(),
    } as any;
    const blockRepository = {
      upsert: jest.fn().mockResolvedValue(undefined),
      find: jest.fn(),
    } as any;
    const microBlockRepository = {
      upsert: jest.fn(),
    } as any;
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'mdw.middlewareUrl') {
          return 'https://mdw.test';
        }
        if (key === 'mdw.microBlocksParallelBatchSize') {
          return 4;
        }
        if (key === 'mdw.pageLimit') {
          return 100;
        }
        return undefined;
      }),
    } as unknown as ConfigService;
    const pluginBatchProcessor = {
      processBatch: jest.fn(),
      // Default: treat every transaction as relevant so the existing
      // persistence tests keep exercising the save/upsert paths.
      filterRelevantTransactions: jest.fn((txs: any[]) => txs),
      isRelevantTransaction: jest.fn(() => true),
    } as any;
    const microBlockService = {
      fetchMicroBlocksForKeyBlock: jest.fn().mockResolvedValue([]),
    } as any;

    const service = new BlockSyncService(
      txRepository,
      blockRepository,
      microBlockRepository,
      configService,
      pluginBatchProcessor,
      microBlockService,
    );

    return {
      service,
      txRepository,
      pluginBatchProcessor,
      blockRepository,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes missing nonce and pow before saving key blocks', async () => {
    const { service, blockRepository } = setup();
    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [
        {
          hash: 'kh_1',
          height: 1,
          prev_hash: 'kh_0',
          prev_key_hash: 'kh_0',
          state_hash: 'bs_1',
          beneficiary: 'ak_ben',
          miner: 'ak_miner',
          time: '1700000000000',
          transactions_count: 1,
          micro_blocks_count: 1,
          beneficiary_reward: '0',
          flags: '{}',
          info: '{}',
          target: '1',
          version: 1,
        },
      ],
      next: null,
    });

    await service.syncBlocks(1, 1);

    expect(blockRepository.upsert).toHaveBeenCalledTimes(1);
    const savedBatch = blockRepository.upsert.mock.calls[0][0];
    expect(savedBatch[0]).toEqual(
      expect.objectContaining({
        hash: 'kh_1',
        nonce: '0',
        pow: [],
      }),
    );
  });

  it('keeps nonce and pow when middleware provides them', async () => {
    const { service, blockRepository } = setup();
    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [
        {
          hash: 'kh_2',
          height: 2,
          prev_hash: 'kh_1',
          prev_key_hash: 'kh_1',
          state_hash: 'bs_2',
          beneficiary: 'ak_ben',
          miner: 'ak_miner',
          time: '1700000000100',
          transactions_count: 0,
          micro_blocks_count: 0,
          beneficiary_reward: '0',
          flags: '{}',
          info: '{}',
          nonce: 7,
          pow: [10, 11, 12],
          target: '1',
          version: 1,
        },
      ],
      next: null,
    });

    await service.syncBlocks(2, 2);

    expect(blockRepository.upsert).toHaveBeenCalledTimes(1);
    const savedBatch = blockRepository.upsert.mock.calls[0][0];
    expect(savedBatch[0]).toEqual(
      expect.objectContaining({
        nonce: '7',
        pow: [10, 11, 12],
      }),
    );
  });

  it('fails fast on pool timeouts instead of falling back to repository.save', async () => {
    const { service, txRepository, pluginBatchProcessor } = setup();
    const loggerError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [buildMiddlewareTransaction()],
      next: null,
    });
    txRepository.upsert.mockRejectedValueOnce(
      new Error('timeout exceeded when trying to connect'),
    );

    await expect(
      service.syncTransactions(123, 123, true, true),
    ).rejects.toThrow('timeout exceeded when trying to connect');

    expect(txRepository.save).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.processBatch).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining(
        'Database connectivity/pool issue during transaction bulk upsert batch: timeout exceeded when trying to connect.',
      ),
      expect.any(String),
    );
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('"issueKind":"pool_timeout"'),
      expect.any(String),
    );
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('"dbPoolMax":40'),
      expect.any(String),
    );
  });

  it('still falls back to repository.save for non-connectivity bulk insert errors', async () => {
    const { service, txRepository, pluginBatchProcessor } = setup();

    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [buildMiddlewareTransaction()],
      next: null,
    });
    txRepository.upsert.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint'),
    );
    txRepository.save.mockResolvedValueOnce({
      hash: 'th_test_1',
      block_height: 123,
    });

    const result = await service.syncTransactions(123, 123, true, true);

    expect(txRepository.save).toHaveBeenCalledTimes(1);
    expect(pluginBatchProcessor.processBatch).toHaveBeenCalledWith(
      [{ hash: 'th_test_1', block_height: 123 }],
      'backward',
    );
    expect(result.get(123)).toEqual(['th_test_1']);
  });

  it('does not persist filtered-out transactions but still records them as observed for validation', async () => {
    // When every plugin rejects a transaction, nothing should be written to
    // the DB. However, block validation MUST still see that MDW returned
    // the transaction for this block; otherwise a misconfigured plugin
    // could cause BlockValidationService to delete canonical rows.
    const { service, txRepository, pluginBatchProcessor } = setup();

    (
      pluginBatchProcessor.filterRelevantTransactions as jest.Mock
    ).mockImplementation(() => []);

    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [buildMiddlewareTransaction()],
      next: null,
    });

    const result = await service.syncTransactions(123, 123, true, true);

    expect(
      pluginBatchProcessor.filterRelevantTransactions,
    ).toHaveBeenCalledTimes(1);
    expect(txRepository.upsert).not.toHaveBeenCalled();
    expect(txRepository.save).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.processBatch).not.toHaveBeenCalled();
    // Observed hash is still tracked so validation compares against the full
    // on-chain set, not the (possibly empty) filtered subset.
    expect(result.get(123)).toEqual(['th_test_1']);
  });

  it('only persists transactions returned by filterRelevantTransactions', async () => {
    const { service, txRepository, pluginBatchProcessor } = setup();

    (
      pluginBatchProcessor.filterRelevantTransactions as jest.Mock
    ).mockImplementation((txs: any[]) =>
      txs.filter((tx) => tx.hash === 'th_relevant'),
    );

    (fetchJson as jest.Mock).mockResolvedValueOnce({
      data: [
        {
          ...buildMiddlewareTransaction(),
          hash: 'th_relevant',
          block_height: 200,
          tx: {
            type: 'ContractCallTx',
            contract_id: 'ct_bcl',
            function: 'buy',
            caller_id: 'ak_caller_1',
          },
        },
        {
          ...buildMiddlewareTransaction(),
          hash: 'th_irrelevant',
          block_height: 200,
          tx: {
            type: 'ContractCallTx',
            contract_id: 'ct_other',
            function: 'something',
            caller_id: 'ak_caller_2',
          },
        },
      ],
      next: null,
    });
    txRepository.upsert.mockResolvedValueOnce(undefined);
    txRepository.find.mockResolvedValueOnce([]);

    const result = await service.syncTransactions(200, 200, true, true);

    expect(
      pluginBatchProcessor.filterRelevantTransactions,
    ).toHaveBeenCalledWith([
      expect.objectContaining({ hash: 'th_relevant' }),
      expect.objectContaining({ hash: 'th_irrelevant' }),
    ]);
    expect(txRepository.upsert).toHaveBeenCalledTimes(1);
    const upsertedBatch = txRepository.upsert.mock.calls[0][0];
    expect(upsertedBatch).toEqual([
      expect.objectContaining({ hash: 'th_relevant' }),
    ]);
    expect(upsertedBatch).toHaveLength(1);
    // Both hashes must be recorded as observed for validation, even though
    // only the relevant one ends up in the DB.
    expect(result.get(200)?.sort()).toEqual(['th_irrelevant', 'th_relevant']);
  });
});

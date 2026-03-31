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
});

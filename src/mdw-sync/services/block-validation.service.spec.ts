import { In, Not } from 'typeorm';
import { fetchJson } from '@/utils/common';
import { BlockValidationService } from './block-validation.service';

jest.mock('@/utils/common', () => ({
  ...jest.requireActual('@/utils/common'),
  fetchJson: jest.fn(),
}));

describe('BlockValidationService', () => {
  const setup = (config: Record<string, unknown> = {}) => {
    const deleteQuery = {
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    const txRepository = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn(() => deleteQuery),
    };
    const values: Record<string, unknown> = {
      'mdw.disableMdwSync': false,
      'mdw.reorgDepth': 0,
      'mdw.middlewareUrl': 'https://mdw.test',
      ...config,
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        values[key] !== undefined ? values[key] : fallback,
      ),
    };
    const pluginBatchProcessor = {
      processBatch: jest.fn().mockResolvedValue(undefined),
      handleReorg: jest.fn().mockResolvedValue(undefined),
    };
    const blockSyncService = {
      syncBlockRange: jest.fn().mockResolvedValue(new Map()),
    };

    const service = new BlockValidationService(
      txRepository as any,
      configService as any,
      pluginBatchProcessor as any,
      blockSyncService as any,
    );

    return {
      service,
      txRepository,
      deleteQuery,
      pluginBatchProcessor,
      blockSyncService,
    };
  };

  beforeEach(() => {
    (fetchJson as jest.Mock).mockReset();
    (fetchJson as jest.Mock).mockResolvedValue({ mdw_height: 10 });
  });

  it('skips while MDW sync is disabled', async () => {
    const { service, blockSyncService } = setup({ 'mdw.disableMdwSync': true });

    await service.validateBlocksPeriodically();

    expect(fetchJson).not.toHaveBeenCalled();
    expect(blockSyncService.syncBlockRange).not.toHaveBeenCalled();
  });

  describe('validation window', () => {
    it('ends at the middleware height and spans the default depth of 100', async () => {
      const { service, txRepository, blockSyncService } = setup({
        'mdw.reorgDepth': undefined,
      });
      (fetchJson as jest.Mock).mockResolvedValue({
        mdw_height: 500,
        top_block_height: 510,
      });

      await service.validateAndRefreshBlocks();

      expect(fetchJson).toHaveBeenCalledWith('https://mdw.test/v3/status');
      expect(blockSyncService.syncBlockRange).toHaveBeenCalledWith(
        400,
        500,
        false,
      );
      const heights = txRepository.find.mock.calls.map(
        ([options]) => options.where.block_height,
      );
      expect(heights).toHaveLength(101);
      expect(heights[0]).toBe(400);
      expect(heights[100]).toBe(500);
    });

    it('falls back to top_block_height and never starts below height 1', async () => {
      const { service, blockSyncService } = setup({
        'mdw.reorgDepth': undefined,
      });
      (fetchJson as jest.Mock).mockResolvedValue({ top_block_height: 50 });

      await service.validateAndRefreshBlocks();

      expect(blockSyncService.syncBlockRange).toHaveBeenCalledWith(
        1,
        50,
        false,
      );
    });
  });

  it('removes txs that left a block and replays the rest as backward', async () => {
    const {
      service,
      txRepository,
      deleteQuery,
      pluginBatchProcessor,
      blockSyncService,
    } = setup();
    blockSyncService.syncBlockRange.mockResolvedValue(
      new Map([[10, ['th_keep']]]),
    );
    const kept = { hash: 'th_keep', block_height: 10 };
    txRepository.find
      .mockResolvedValueOnce([{ hash: 'th_gone' }])
      .mockResolvedValueOnce([kept]);

    await service.validateAndRefreshBlocks();

    expect(blockSyncService.syncBlockRange).toHaveBeenCalledWith(10, 10, false);
    expect(txRepository.find).toHaveBeenNthCalledWith(1, {
      where: { block_height: 10, hash: Not(In(['th_keep'])) },
      select: ['hash'],
    });
    expect(deleteQuery.where).toHaveBeenCalledWith(
      'block_height = :blockHeight',
      { blockHeight: 10 },
    );
    expect(deleteQuery.andWhere).toHaveBeenCalledWith('hash IN (:...hashes)', {
      hashes: ['th_gone'],
    });
    expect(pluginBatchProcessor.handleReorg).toHaveBeenCalledWith(['th_gone']);
    expect(pluginBatchProcessor.processBatch).toHaveBeenCalledWith(
      [kept],
      'backward',
    );

    // Plugins are told only after the rows are gone (the onReorg contract),
    // and the surviving txs are replayed after the cleanup.
    const deletedAt = deleteQuery.execute.mock.invocationCallOrder[0];
    const reorgAt =
      pluginBatchProcessor.handleReorg.mock.invocationCallOrder[0];
    const replayAt =
      pluginBatchProcessor.processBatch.mock.invocationCallOrder[0];
    expect(deletedAt).toBeLessThan(reorgAt);
    expect(reorgAt).toBeLessThan(replayAt);
  });

  it('empties a block the middleware now reports without txs', async () => {
    const { service, txRepository, pluginBatchProcessor, blockSyncService } =
      setup();
    blockSyncService.syncBlockRange.mockResolvedValue(new Map());
    txRepository.find.mockResolvedValueOnce([
      { hash: 'th_a' },
      { hash: 'th_b' },
    ]);

    await service.validateAndRefreshBlocks();

    expect(txRepository.delete).toHaveBeenCalledWith({ block_height: 10 });
    expect(pluginBatchProcessor.handleReorg).toHaveBeenCalledWith([
      'th_a',
      'th_b',
    ]);
    expect(txRepository.delete.mock.invocationCallOrder[0]).toBeLessThan(
      pluginBatchProcessor.handleReorg.mock.invocationCallOrder[0],
    );
    expect(pluginBatchProcessor.processBatch).not.toHaveBeenCalled();
  });

  it('leaves an empty block alone when nothing is stored for it', async () => {
    const { service, txRepository, pluginBatchProcessor } = setup();

    await service.validateAndRefreshBlocks();

    expect(txRepository.find).toHaveBeenCalledWith({
      where: { block_height: 10 },
    });
    expect(txRepository.delete).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.handleReorg).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.processBatch).not.toHaveBeenCalled();
  });

  it('leaves a block alone when nothing left it', async () => {
    const { service, txRepository, pluginBatchProcessor, blockSyncService } =
      setup();
    blockSyncService.syncBlockRange.mockResolvedValue(
      new Map([[10, ['th_keep']]]),
    );
    txRepository.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ hash: 'th_keep', block_height: 10 }]);

    await service.validateAndRefreshBlocks();

    expect(txRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.handleReorg).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.processBatch).toHaveBeenCalledTimes(1);
  });

  it('validates the remaining blocks when one block fails', async () => {
    const { service, txRepository, pluginBatchProcessor, blockSyncService } =
      setup({ 'mdw.reorgDepth': 1 });
    blockSyncService.syncBlockRange.mockResolvedValue(
      new Map([
        [9, ['th_9']],
        [10, ['th_10']],
      ]),
    );
    const tx10 = { hash: 'th_10', block_height: 10 };
    txRepository.find
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([tx10]);

    await service.validateAndRefreshBlocks();

    expect(blockSyncService.syncBlockRange).toHaveBeenCalledWith(9, 10, false);
    expect(pluginBatchProcessor.processBatch).toHaveBeenCalledWith(
      [tx10],
      'backward',
    );
  });

  it.each([
    ['the tip lookup', 'status'],
    ['the refetch', 'refetch'],
  ])('deletes nothing when %s fails', async (_label, failing) => {
    const { service, txRepository, pluginBatchProcessor, blockSyncService } =
      setup();
    if (failing === 'status') {
      (fetchJson as jest.Mock).mockRejectedValueOnce(new Error('mdw 503'));
    } else {
      blockSyncService.syncBlockRange.mockRejectedValueOnce(
        new Error('mdw 503'),
      );
    }

    await expect(service.validateBlocksPeriodically()).resolves.toBeUndefined();

    expect(txRepository.find).not.toHaveBeenCalled();
    expect(txRepository.delete).not.toHaveBeenCalled();
    expect(txRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.handleReorg).not.toHaveBeenCalled();
    expect(pluginBatchProcessor.processBatch).not.toHaveBeenCalled();

    // The guard is released, so the next tick runs.
    expect(service.getIsValidating()).toBe(false);
    await service.validateBlocksPeriodically();
    expect(txRepository.find).toHaveBeenCalled();
  });

  it('does not start a second pass while one is running', async () => {
    const { service, blockSyncService } = setup();
    let finish!: (value: Map<number, string[]>) => void;
    blockSyncService.syncBlockRange.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const first = service.validateBlocksPeriodically();
    // Let the first pass reach syncBlockRange before starting the second.
    await new Promise((resolve) => setImmediate(resolve));
    await service.validateBlocksPeriodically();
    expect(service.getIsValidating()).toBe(true);

    finish(new Map());
    await first;

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(service.getIsValidating()).toBe(false);
  });
});

import { PluginFailedTransactionService } from './plugin-failed-transaction.service';
import { Tx } from '../entities/tx.entity';

describe('Plugin failed transaction retries', () => {
  const one = { hash: 'th_one' } as Tx;
  const two = { hash: 'th_two' } as Tx;
  function setup() {
    const query = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    const failed = {
      find: jest.fn().mockResolvedValue([one, two]),
      findOne: jest.fn().mockResolvedValue({}),
      upsert: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: () => query,
    };
    const txs = {
      find: jest.fn().mockResolvedValue([one, two]),
      findOne: jest.fn().mockResolvedValue(one),
    };
    const plugin = { version: 2, processBatch: jest.fn() };
    const service = new PluginFailedTransactionService(
      failed as any,
      txs as any,
      {} as any,
      { getPluginByName: () => plugin } as any,
    );
    return { service, failed, plugin, query };
  }

  it('keeps per-transaction failures and removes only successful retries', async () => {
    const { service, failed, plugin, query } = setup();
    plugin.processBatch.mockResolvedValue({
      failed: [{ tx: two, error: new Error('decode failed') }],
    });
    await service.retryFailedTransactions('shorts', 1, 2);
    expect(query.andWhere).toHaveBeenCalledWith('tx_hash IN (:...hashes)', {
      hashes: ['th_one'],
    });
    expect(failed.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tx_hash: 'th_two',
        version: 2,
        error_message: 'decode failed',
      }),
      ['plugin_name', 'tx_hash'],
    );
  });

  it('reports a failed single retry as failure instead of deleting it', async () => {
    const { service, failed, plugin } = setup();
    plugin.processBatch.mockResolvedValue({
      failed: [{ tx: one, error: new Error('offline') }],
    });
    expect(await service.retryFailedTransaction('shorts', one.hash)).toBe(
      false,
    );
    expect(failed.delete).not.toHaveBeenCalled();
    expect(failed.upsert).toHaveBeenCalled();
  });

  it('still supports plugins returning void and removes successful single retries', async () => {
    const { service, failed, plugin } = setup();
    plugin.processBatch.mockResolvedValue(undefined);
    expect(await service.retryFailedTransaction('shorts', one.hash)).toBe(true);
    expect(failed.delete).toHaveBeenCalledWith({
      plugin_name: 'shorts',
      tx_hash: one.hash,
    });
  });
});

import { BclPlugin } from './bcl.plugin';

describe('BclPlugin.onReorg', () => {
  const setup = () => {
    const deleteQuery = {
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [], affected: 0 }),
    };
    const transactionRepository = {
      createQueryBuilder: jest.fn(() => deleteQuery),
    };
    const accountService = {
      ensureAccountFromTransactions: jest.fn().mockResolvedValue(null),
    };
    const plugin = new BclPlugin(
      {} as any,
      {} as any,
      transactionRepository as any,
      {} as any,
      accountService as any,
    );
    const logError = jest
      .spyOn((plugin as any).logger, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn((plugin as any).logger, 'log').mockImplementation(() => {});

    return {
      plugin,
      deleteQuery,
      transactionRepository,
      accountService,
      logError,
    };
  };

  it('does nothing for an empty hash list', async () => {
    const { plugin, transactionRepository, accountService } = setup();

    await plugin.onReorg([]);

    expect(transactionRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(accountService.ensureAccountFromTransactions).not.toHaveBeenCalled();
  });

  it('deletes the trades of the removed txs and refreshes each trader once', async () => {
    const { plugin, deleteQuery, accountService } = setup();
    deleteQuery.execute.mockResolvedValue({
      raw: [{ address: 'ak_a' }, { address: 'ak_b' }, { address: 'ak_a' }],
      affected: 3,
    });

    await plugin.onReorg(['th_1', 'th_2', 'th_3']);

    expect(deleteQuery.where).toHaveBeenCalledWith('tx_hash IN (:...hashes)', {
      hashes: ['th_1', 'th_2', 'th_3'],
    });
    expect(deleteQuery.returning).toHaveBeenCalledWith('address');
    expect(
      accountService.ensureAccountFromTransactions.mock.calls.map(([a]) => a),
    ).toEqual(['ak_a', 'ak_b']);
  });

  it('refreshes no account when none of the txs had a trade', async () => {
    const { plugin, accountService } = setup();

    await plugin.onReorg(['th_not_bcl']);

    expect(accountService.ensureAccountFromTransactions).not.toHaveBeenCalled();
  });

  it('logs a failed delete and refreshes nothing', async () => {
    const { plugin, deleteQuery, accountService, logError } = setup();
    deleteQuery.execute.mockRejectedValue(new Error('pool timeout'));

    await expect(plugin.onReorg(['th_1'])).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clean up removed transactions'),
      expect.any(Error),
    );
    expect(accountService.ensureAccountFromTransactions).not.toHaveBeenCalled();
  });

  it('keeps refreshing the other traders when one refresh fails', async () => {
    const { plugin, deleteQuery, accountService, logError } = setup();
    deleteQuery.execute.mockResolvedValue({
      raw: [{ address: 'ak_a' }, { address: 'ak_b' }],
      affected: 2,
    });
    accountService.ensureAccountFromTransactions.mockRejectedValueOnce(
      new Error('pool timeout'),
    );

    await expect(plugin.onReorg(['th_1', 'th_2'])).resolves.toBeUndefined();

    expect(accountService.ensureAccountFromTransactions).toHaveBeenCalledWith(
      'ak_b',
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('ak_a'),
      expect.any(Error),
    );
  });
});

import {
  FAILED_TX_RETRY_LOCK_KEY,
  nextRetryAt,
  PluginFailedTransactionService,
} from './plugin-failed-transaction.service';

// The due-row selection is SQL; see plugin-failed-transaction.service.integration.spec.ts.
describe('PluginFailedTransactionService', () => {
  const setup = (config: Record<string, unknown> = {}) => {
    const failedTransactionRepository = {
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const syncStateRepository = { findOne: jest.fn() };
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
    const plugin = { name: 'bcl', version: 2, processBatch: jest.fn() };
    const pluginRegistryService = { getPlugins: jest.fn(() => [plugin]) };
    const values: Record<string, unknown> = {
      'mdw.disableMdwSync': false,
      ...config,
    };
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key in values ? values[key] : fallback,
      ),
    };

    const service = new PluginFailedTransactionService(
      failedTransactionRepository as any,
      {} as any,
      syncStateRepository as any,
      dataSource as any,
      pluginRegistryService as any,
      configService as any,
    );

    return { service, failedTransactionRepository, queryRunner, dataSource };
  };

  describe('retryDueFailedTransactions', () => {
    it('does nothing while MDW sync is disabled', async () => {
      const { service, dataSource } = setup({ 'mdw.disableMdwSync': true });

      await service.retryDueFailedTransactions();

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('skips the run when another instance holds the lock', async () => {
      const { service, queryRunner } = setup();
      queryRunner.query.mockResolvedValueOnce([{ locked: false }]);
      const retryDue = jest.spyOn(service, 'retryDue');

      await service.retryDueFailedTransactions();

      expect(retryDue).not.toHaveBeenCalled();
      expect(queryRunner.query).toHaveBeenCalledTimes(1);
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('unlocks and releases the connection after a run', async () => {
      const { service, queryRunner } = setup();
      const retryDue = jest
        .spyOn(service, 'retryDue')
        .mockResolvedValue(undefined);

      await service.retryDueFailedTransactions();

      expect(retryDue).toHaveBeenCalled();
      expect(queryRunner.query).toHaveBeenLastCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [FAILED_TX_RETRY_LOCK_KEY],
      );
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('runs again after a failed run', async () => {
      const { service, dataSource, queryRunner } = setup();
      jest
        .spyOn(service, 'retryDue')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined);

      await service.retryDueFailedTransactions();
      await service.retryDueFailedTransactions();

      expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(2);
      expect(queryRunner.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [FAILED_TX_RETRY_LOCK_KEY],
      );
    });
  });

  describe('nextRetryAt', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    const minutesAfter = (attempts: number) =>
      (nextRetryAt(attempts, now).getTime() - now.getTime()) / 60_000;

    it('doubles from 10 minutes and caps at a day', () => {
      expect(minutesAfter(1)).toBe(10);
      expect(minutesAfter(2)).toBe(20);
      expect(minutesAfter(4)).toBe(80);
      expect(minutesAfter(9)).toBe(24 * 60);
      expect(minutesAfter(20)).toBe(24 * 60);
    });
  });

  describe('clearFailures', () => {
    it('skips the query for an empty list', async () => {
      const { service, failedTransactionRepository } = setup();

      await service.clearFailures('bcl', []);

      expect(failedTransactionRepository.delete).not.toHaveBeenCalled();
    });

    it('never throws into indexing', async () => {
      const { service, failedTransactionRepository } = setup();
      failedTransactionRepository.delete.mockRejectedValue(new Error('down'));

      await expect(
        service.clearFailures('bcl', ['th_a']),
      ).resolves.toBeUndefined();
      await expect(
        service.clearFailuresForTxs(['th_a']),
      ).resolves.toBeUndefined();
    });
  });
});

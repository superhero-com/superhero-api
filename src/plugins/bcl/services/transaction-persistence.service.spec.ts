import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { TransactionPersistenceService } from './transaction-persistence.service';
import { Logger } from '@nestjs/common';

describe('TransactionPersistenceService', () => {
  let service: TransactionPersistenceService;
  let accountService: any;

  beforeEach(() => {
    accountService = {
      ensureAccountFromTransactions: jest.fn().mockResolvedValue(null),
    };
    service = new TransactionPersistenceService(accountService as any);
  });

  it('updates token transaction counters after saving a transaction', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ tx_hash: 'th_1' });
    const count = jest.fn().mockResolvedValue(7);
    const update = jest.fn().mockResolvedValue(undefined);
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count };
        }

        if (entity === Token) {
          return { update };
        }

        throw new Error('Unexpected repository request');
      }),
    };

    const transaction = await service.saveTransaction(
      {
        tx_hash: 'th_1',
        sale_address: 'ct_sale',
        address: 'ak_trader',
      } as any,
      manager as any,
    );

    expect(upsert).toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith({
      where: { sale_address: 'ct_sale' },
    });
    expect(update).toHaveBeenCalledWith('ct_sale', {
      tx_count: 7,
      last_sync_tx_count: 7,
    });
    expect(accountService.ensureAccountFromTransactions).toHaveBeenCalledWith(
      'ak_trader',
      manager,
    );
    expect(transaction).toEqual({ tx_hash: 'th_1' });
  });

  it('returns cleaned up account addresses so callers can refresh stale totals', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ address: 'ak_old' }, { address: null }]);
    const execute = jest.fn().mockResolvedValue(undefined);
    const andWhere = jest.fn().mockReturnThis();
    const where = jest.fn().mockReturnThis();
    const from = jest.fn().mockReturnThis();
    const deleteQuery = jest.fn().mockReturnThis();
    const manager = {
      query,
      createQueryBuilder: jest.fn(() => ({
        delete: deleteQuery,
        from,
        where,
        andWhere,
        execute,
      })),
    };

    const addresses = await service.cleanupOldTransactions(
      'ct_sale',
      'th_current',
      manager as any,
    );

    expect(addresses).toEqual(['ak_old']);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT DISTINCT address'),
      ['ct_sale', 'create_community', 'th_current'],
    );
    expect(execute).toHaveBeenCalled();
  });

  it('does not fail transaction persistence when counter refresh fails', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ tx_hash: 'th_2' });
    const count = jest.fn().mockResolvedValue(8);
    const update = jest.fn().mockRejectedValue(new Error('update failed'));
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count };
        }

        if (entity === Token) {
          return { update };
        }

        throw new Error('Unexpected repository request');
      }),
    };

    const transaction = await service.saveTransaction(
      {
        tx_hash: 'th_2',
        sale_address: 'ct_sale',
      } as any,
      manager as any,
    );

    expect(transaction).toEqual({ tx_hash: 'th_2' });
    expect(update).toHaveBeenCalledWith('ct_sale', {
      tx_count: 8,
      last_sync_tx_count: 8,
    });
    expect(loggerError).toHaveBeenCalled();
  });

  it('does not fail transaction persistence when account totals refresh fails', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ tx_hash: 'th_3' });
    const query = jest.fn().mockRejectedValue(new Error('insert failed'));
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const manager = {
      query,
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne };
        }
        if (entity === Token) {
          return { update: jest.fn() };
        }
        throw new Error('Unexpected repository request');
      }),
    };

    accountService.ensureAccountFromTransactions.mockRejectedValue(
      new Error('insert failed'),
    );

    const transaction = await service.saveTransaction(
      {
        tx_hash: 'th_3',
        address: 'ak_trader',
      } as any,
      manager as any,
    );

    expect(transaction).toEqual({ tx_hash: 'th_3' });
    expect(accountService.ensureAccountFromTransactions).toHaveBeenCalledWith(
      'ak_trader',
      manager,
    );
    expect(loggerError).toHaveBeenCalled();
  });
});

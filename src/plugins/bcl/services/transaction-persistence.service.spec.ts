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
    const exists = jest.fn().mockResolvedValue(false);
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count, exists };
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

  it('acquires an advisory lock on tx_hash before checking whether the transaction is new', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ tx_hash: 'th_lock' });
    const count = jest.fn().mockResolvedValue(1);
    const exists = jest.fn().mockResolvedValue(false);
    const query = jest.fn().mockResolvedValue(undefined);
    const manager = {
      query,
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count, exists };
        }
        if (entity === Token) {
          return { update: jest.fn() };
        }
        throw new Error('Unexpected repository request');
      }),
    };

    await service.saveTransaction(
      {
        tx_hash: 'th_lock',
        sale_address: 'ct_sale',
        tx_type: 'buy',
      } as any,
      manager as any,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock(hashtext($1))'),
      ['th_lock'],
    );
    const lockCallOrder = query.mock.invocationCallOrder[0];
    const existsCallOrder = exists.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(existsCallOrder);
  });

  it('does not fail transaction persistence when the advisory lock cannot be acquired', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ tx_hash: 'th_lockfail' });
    const count = jest.fn().mockResolvedValue(1);
    const exists = jest.fn().mockResolvedValue(false);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error('lock unavailable'))
      .mockResolvedValue(undefined);
    const manager = {
      query,
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count, exists };
        }
        if (entity === Token) {
          return { update: jest.fn() };
        }
        throw new Error('Unexpected repository request');
      }),
    };

    const transaction = await service.saveTransaction(
      {
        tx_hash: 'th_lockfail',
        sale_address: 'ct_sale',
        tx_type: 'buy',
      } as any,
      manager as any,
    );

    expect(transaction).toEqual({ tx_hash: 'th_lockfail' });
    expect(loggerError).toHaveBeenCalled();
    loggerError.mockRestore();
  });

  it('increments the trade eligibility counter for a new buy/sell transaction', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ tx_hash: 'th_buy' });
    const count = jest.fn().mockResolvedValue(1);
    const exists = jest.fn().mockResolvedValue(false);
    const query = jest.fn().mockResolvedValue(undefined);
    const manager = {
      query,
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count, exists };
        }
        if (entity === Token) {
          return { update: jest.fn() };
        }
        throw new Error('Unexpected repository request');
      }),
    };

    await service.saveTransaction(
      {
        tx_hash: 'th_buy',
        sale_address: 'ct_sale',
        tx_type: 'buy',
      } as any,
      manager as any,
    );

    expect(exists).toHaveBeenCalledWith({ where: { tx_hash: 'th_buy' } });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO token_trade_eligibility_counts'),
      ['ct_sale'],
    );
  });

  it('does not increment the trade eligibility counter for a re-processed transaction', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ tx_hash: 'th_buy' });
    const count = jest.fn().mockResolvedValue(1);
    const exists = jest.fn().mockResolvedValue(true);
    const query = jest.fn().mockResolvedValue(undefined);
    const manager = {
      query,
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count, exists };
        }
        if (entity === Token) {
          return { update: jest.fn() };
        }
        throw new Error('Unexpected repository request');
      }),
    };

    await service.saveTransaction(
      {
        tx_hash: 'th_buy',
        sale_address: 'ct_sale',
        tx_type: 'buy',
      } as any,
      manager as any,
    );

    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO token_trade_eligibility_counts'),
      expect.anything(),
    );
  });

  it('does not increment the trade eligibility counter for non-trade tx types', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const findOne = jest.fn().mockResolvedValue({ tx_hash: 'th_create' });
    const count = jest.fn().mockResolvedValue(1);
    const exists = jest.fn().mockResolvedValue(false);
    const query = jest.fn().mockResolvedValue(undefined);
    const manager = {
      query,
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count, exists };
        }
        if (entity === Token) {
          return { update: jest.fn() };
        }
        throw new Error('Unexpected repository request');
      }),
    };

    await service.saveTransaction(
      {
        tx_hash: 'th_create',
        sale_address: 'ct_sale',
        tx_type: 'create_community',
      } as any,
      manager as any,
    );

    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO token_trade_eligibility_counts'),
      expect.anything(),
    );
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
    const exists = jest.fn().mockResolvedValue(false);
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, count, exists };
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
    const exists = jest.fn().mockResolvedValue(false);
    const manager = {
      query,
      getRepository: jest.fn((entity) => {
        if (entity === Transaction) {
          return { upsert, findOne, exists };
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

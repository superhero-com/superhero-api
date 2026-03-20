import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { TransactionPersistenceService } from './transaction-persistence.service';

describe('TransactionPersistenceService', () => {
  let service: TransactionPersistenceService;

  beforeEach(() => {
    service = new TransactionPersistenceService();
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
    expect(transaction).toEqual({ tx_hash: 'th_1' });
  });
});

import { BCL_FUNCTIONS } from '@/configs';
import { SyncDirectionEnum } from '../../plugin.interface';
import { TransactionProcessorService } from './transaction-processor.service';

describe('TransactionProcessorService', () => {
  let service: TransactionProcessorService;
  let validationService: { validateTransaction: jest.Mock };
  let persistenceService: { cleanupOldTransactions: jest.Mock };
  let tokenService: {
    getToken: jest.Mock;
    createTokenFromRawTransaction: jest.Mock;
  };

  beforeEach(() => {
    validationService = {
      validateTransaction: jest.fn(),
    };
    persistenceService = {
      cleanupOldTransactions: jest.fn(),
    };

    tokenService = {
      getToken: jest.fn(),
      createTokenFromRawTransaction: jest.fn(),
    };

    const transactionRepository = {
      manager: {
        transaction: jest.fn(async (handler: any) => handler({})),
      },
    };

    service = new TransactionProcessorService(
      validationService as any,
      {} as any,
      persistenceService as any,
      {} as any,
      tokenService as any,
      {} as any,
      transactionRepository as any,
    );
  });

  it('skips non-create tx when token is missing without creating token', async () => {
    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      saleAddress: 'ct_missing',
    });
    tokenService.getToken.mockResolvedValue(null);

    const result = await service.processTransaction(
      {
        hash: 'th_non_create',
        function: BCL_FUNCTIONS.buy,
      } as any,
      SyncDirectionEnum.Live,
    );

    expect(result).toBeNull();
    expect(tokenService.getToken).toHaveBeenCalledWith('ct_missing');
    expect(tokenService.createTokenFromRawTransaction).not.toHaveBeenCalled();
  });

  it('skips create_community tx when token creation returns null', async () => {
    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      saleAddress: 'ct_missing',
    });
    tokenService.getToken.mockResolvedValue(null);
    tokenService.createTokenFromRawTransaction.mockResolvedValue(null);

    const result = await service.processTransaction(
      {
        hash: 'th_create',
        function: BCL_FUNCTIONS.create_community,
      } as any,
      SyncDirectionEnum.Live,
    );

    expect(result).toBeNull();
    expect(persistenceService.cleanupOldTransactions).toHaveBeenCalledTimes(1);
    expect(tokenService.createTokenFromRawTransaction).toHaveBeenCalledTimes(1);
  });
});

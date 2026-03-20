import BigNumber from 'bignumber.js';
import { BCL_FUNCTIONS } from '@/configs';
import { SyncDirectionEnum } from '../../plugin.interface';
import { TransactionProcessorService } from './transaction-processor.service';

describe('TransactionProcessorService', () => {
  let service: TransactionProcessorService;
  let validationService: { validateTransaction: jest.Mock };
  let dataService: {
    calculatePrices: jest.Mock;
    prepareTransactionData: jest.Mock;
  };
  let persistenceService: {
    cleanupOldTransactions: jest.Mock;
    saveTransaction: jest.Mock;
  };
  let transactionsService: {
    decodeTxEvents: jest.Mock;
    parseTransactionData: jest.Mock;
    isTokenSupportedCollection: jest.Mock;
  };
  let tokenService: {
    getToken: jest.Mock;
    createTokenFromRawTransaction: jest.Mock;
    update: jest.Mock;
    updateTokenMetaDataFromCreateTx: jest.Mock;
    syncTokenPrice: jest.Mock;
    updateTokenTrendingScore: jest.Mock;
    findByAddress: jest.Mock;
  };
  let tokenHolderService: { updateTokenHolder: jest.Mock };

  beforeEach(() => {
    validationService = {
      validateTransaction: jest.fn(),
    };
    dataService = {
      calculatePrices: jest.fn(),
      prepareTransactionData: jest.fn(),
    };
    persistenceService = {
      cleanupOldTransactions: jest.fn(),
      saveTransaction: jest.fn(),
    };
    transactionsService = {
      decodeTxEvents: jest.fn(),
      parseTransactionData: jest.fn(),
      isTokenSupportedCollection: jest.fn(),
    };
    tokenService = {
      getToken: jest.fn(),
      createTokenFromRawTransaction: jest.fn(),
      update: jest.fn(),
      updateTokenMetaDataFromCreateTx: jest.fn(),
      syncTokenPrice: jest.fn(),
      updateTokenTrendingScore: jest.fn(),
      findByAddress: jest.fn(),
    };
    tokenHolderService = {
      updateTokenHolder: jest.fn(),
    };

    const transactionRepository = {
      manager: {
        transaction: jest.fn(async (handler: any) => handler({})),
      },
    };

    service = new TransactionProcessorService(
      validationService as any,
      dataService as any,
      persistenceService as any,
      transactionsService as any,
      tokenService as any,
      tokenHolderService as any,
      transactionRepository as any,
    );
  });

  it('skips transactions rejected by validation', async () => {
    validationService.validateTransaction.mockResolvedValue({
      isValid: false,
      saleAddress: null,
    });

    const result = await service.processTransaction(
      {
        hash: 'th_invalid',
        function: BCL_FUNCTIONS.buy,
      } as any,
      SyncDirectionEnum.Live,
    );

    expect(result).toBeNull();
    expect(tokenService.getToken).not.toHaveBeenCalled();
    expect(persistenceService.saveTransaction).not.toHaveBeenCalled();
  });

  it('rejects buy transactions that have no decoded events yet', async () => {
    const rawTransaction = {
      hash: 'th_broken_live',
      function: BCL_FUNCTIONS.buy,
      block_height: 123,
      caller_id: 'ak_test',
      raw: { log: [] },
    };
    const token = {
      sale_address: 'ct_sale',
      factory_address: 'ct_factory',
    };

    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      saleAddress: 'ct_sale',
    });
    tokenService.getToken.mockResolvedValue(token);
    transactionsService.decodeTxEvents.mockResolvedValue(rawTransaction);
    transactionsService.parseTransactionData.mockResolvedValue({
      amount: new BigNumber(0),
      volume: new BigNumber(0),
      total_supply: new BigNumber(0),
      protocol_reward: new BigNumber(0),
      _should_revalidate: true,
    });

    await expect(
      service.processTransaction(rawTransaction as any, SyncDirectionEnum.Live),
    ).rejects.toThrow(
      'Missing decoded events for buy transaction th_broken_live',
    );

    expect(dataService.calculatePrices).not.toHaveBeenCalled();
    expect(persistenceService.saveTransaction).not.toHaveBeenCalled();
  });

  it('updates the trending score after a successful live transaction', async () => {
    const rawTransaction = {
      hash: 'th_live_success',
      function: BCL_FUNCTIONS.buy,
      block_height: 123,
      caller_id: 'ak_test',
      raw: { log: [] },
    };
    const token = {
      sale_address: 'ct_sale',
      factory_address: 'ct_factory',
    };

    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      saleAddress: 'ct_sale',
    });
    tokenService.getToken.mockResolvedValue(token);
    transactionsService.decodeTxEvents.mockResolvedValue(rawTransaction);
    transactionsService.parseTransactionData.mockResolvedValue({
      amount: new BigNumber(10),
      volume: new BigNumber(2),
      total_supply: new BigNumber(100),
      protocol_reward: new BigNumber(1),
    });
    dataService.calculatePrices.mockReturnValue({
      unitPriceData: { ae: 1 },
      marketCapData: { ae: 10 },
      buyPriceData: { ae: 1 },
      previousBuyPriceData: { ae: 1 },
    });
    dataService.prepareTransactionData.mockResolvedValue({
      tx_hash: rawTransaction.hash,
    });
    persistenceService.saveTransaction.mockResolvedValue({ id: 1 });
    tokenService.update.mockResolvedValue(token);
    transactionsService.isTokenSupportedCollection.mockResolvedValue(true);
    tokenService.syncTokenPrice.mockResolvedValue(undefined);
    tokenHolderService.updateTokenHolder.mockResolvedValue(undefined);
    tokenService.updateTokenTrendingScore.mockResolvedValue(undefined);

    await service.processTransaction(rawTransaction as any, SyncDirectionEnum.Live);

    expect(tokenService.updateTokenTrendingScore).toHaveBeenCalledWith(token);
  });
});

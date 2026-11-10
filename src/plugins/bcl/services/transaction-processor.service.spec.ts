import BigNumber from 'bignumber.js';
import { BCL_FUNCTIONS } from '@/configs';
import { Logger } from '@nestjs/common';
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
    refreshAccountFromTransactions: jest.Mock;
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
    refreshTokenPrice: jest.Mock;
    updateTokenTrendingScore: jest.Mock;
    findByAddress: jest.Mock;
  };
  let tokenHolderService: { updateTokenHolder: jest.Mock };
  let transaction: jest.Mock;
  let committed: boolean;

  beforeEach(() => {
    validationService = {
      validateTransaction: jest.fn(),
    };
    dataService = {
      calculatePrices: jest.fn(),
      prepareTransactionData: jest.fn(),
    };
    persistenceService = {
      cleanupOldTransactions: jest.fn().mockResolvedValue([]),
      saveTransaction: jest.fn(),
      refreshAccountFromTransactions: jest.fn(),
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
      refreshTokenPrice: jest.fn().mockResolvedValue(undefined),
      updateTokenTrendingScore: jest.fn(),
      findByAddress: jest.fn(),
    };
    tokenHolderService = {
      updateTokenHolder: jest.fn(),
    };

    committed = false;
    transaction = jest.fn(async (handler: any) => {
      const result = await handler({});
      committed = true;
      return result;
    });
    const transactionRepository = { manager: { transaction } };

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

  it('parks a buy whose token lookup fails instead of skipping it', async () => {
    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      saleAddress: 'ct_sale',
    });
    tokenService.getToken.mockRejectedValue(
      new Error('timeout exceeded when trying to connect'),
    );

    await expect(
      service.processTransaction(
        { hash: 'th_buy', function: BCL_FUNCTIONS.buy } as any,
        SyncDirectionEnum.Live,
      ),
    ).rejects.toThrow('timeout exceeded when trying to connect');
    expect(persistenceService.saveTransaction).not.toHaveBeenCalled();
  });

  it('still falls back to the raw tx for create_community when the token lookup fails', async () => {
    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      saleAddress: 'ct_sale',
    });
    tokenService.getToken.mockRejectedValue(new Error('not deployed yet'));
    tokenService.createTokenFromRawTransaction.mockResolvedValue(null);

    await expect(
      service.processTransaction(
        { hash: 'th_create', function: BCL_FUNCTIONS.create_community } as any,
        SyncDirectionEnum.Live,
      ),
    ).resolves.toBeNull();
    expect(tokenService.createTokenFromRawTransaction).toHaveBeenCalled();
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
    tokenHolderService.updateTokenHolder.mockResolvedValue(undefined);
    tokenService.updateTokenTrendingScore.mockResolvedValue(undefined);

    await service.processTransaction(
      rawTransaction as any,
      SyncDirectionEnum.Live,
    );

    expect(tokenService.updateTokenTrendingScore).toHaveBeenCalledWith(token);
  });

  it('continues processing when cleanup account refresh fails', async () => {
    const rawTransaction = {
      hash: 'th_cleanup_fail',
      function: BCL_FUNCTIONS.create_community,
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
      address: 'ak_trader',
    });
    persistenceService.saveTransaction.mockResolvedValue({ id: 1 });
    persistenceService.cleanupOldTransactions.mockResolvedValue(['ak_old']);
    persistenceService.refreshAccountFromTransactions.mockRejectedValue(
      new Error('insert failed'),
    );
    tokenService.update.mockResolvedValue(token);
    transactionsService.isTokenSupportedCollection.mockResolvedValue(true);
    tokenHolderService.updateTokenHolder.mockResolvedValue(undefined);
    tokenService.updateTokenTrendingScore.mockResolvedValue(undefined);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(
      service.processTransaction(rawTransaction as any, SyncDirectionEnum.Live),
    ).resolves.not.toThrow();

    expect(
      persistenceService.refreshAccountFromTransactions,
    ).toHaveBeenCalledWith('ak_old', expect.anything());
    expect(loggerError).toHaveBeenCalled();
  });

  describe('outside the transaction', () => {
    const rawTransaction = {
      hash: 'th_live',
      function: BCL_FUNCTIONS.buy,
      block_height: 123,
      caller_id: 'ak_test',
      raw: { log: [] },
    };
    const token = {
      sale_address: 'ct_sale',
      factory_address: 'ct_factory',
    };
    let emitBalanceChanged: jest.Mock;

    beforeEach(() => {
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
        _should_revalidate: false,
      });
      dataService.calculatePrices.mockReturnValue({});
      dataService.prepareTransactionData.mockResolvedValue({
        tx_hash: rawTransaction.hash,
      });
      persistenceService.saveTransaction.mockResolvedValue({ id: 1 });
      tokenService.update.mockResolvedValue(token);
      transactionsService.isTokenSupportedCollection.mockResolvedValue(true);
      emitBalanceChanged = jest.fn();
      tokenHolderService.updateTokenHolder.mockResolvedValue(
        emitBalanceChanged,
      );
      tokenService.updateTokenTrendingScore.mockResolvedValue(undefined);
    });

    it('resolves the token before opening the transaction', async () => {
      await service.processTransaction(
        rawTransaction as any,
        SyncDirectionEnum.Live,
      );

      expect(tokenService.getToken.mock.invocationCallOrder[0]).toBeLessThan(
        transaction.mock.invocationCallOrder[0],
      );
    });

    it('skips an unavailable token without opening a transaction', async () => {
      tokenService.getToken.mockResolvedValue(null);

      await expect(
        service.processTransaction(
          rawTransaction as any,
          SyncDirectionEnum.Live,
        ),
      ).resolves.toBeNull();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('refreshes the live price after commit', async () => {
      let committedAtRefresh: boolean | undefined;
      tokenService.refreshTokenPrice.mockImplementation(async () => {
        committedAtRefresh = committed;
      });

      await service.processTransaction(
        rawTransaction as any,
        SyncDirectionEnum.Live,
      );

      expect(committedAtRefresh).toBe(true);
      expect(tokenService.refreshTokenPrice).toHaveBeenCalledTimes(1);
      expect(tokenService.refreshTokenPrice).toHaveBeenCalledWith(token);
    });

    it('waits for the refresh before the balance emit and trending update', async () => {
      let finishRefresh: () => void = () => undefined;
      tokenService.refreshTokenPrice.mockReturnValue(
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
      );

      const processing = service.processTransaction(
        rawTransaction as any,
        SyncDirectionEnum.Live,
      );
      await new Promise(setImmediate);

      expect(tokenService.refreshTokenPrice).toHaveBeenCalled();
      expect(emitBalanceChanged).not.toHaveBeenCalled();
      expect(tokenService.updateTokenTrendingScore).not.toHaveBeenCalled();

      finishRefresh();
      await processing;

      expect(emitBalanceChanged).toHaveBeenCalledTimes(1);
      expect(tokenService.updateTokenTrendingScore).toHaveBeenCalledWith(token);
    });

    it('does not refresh when the transaction rolls back', async () => {
      tokenHolderService.updateTokenHolder.mockRejectedValue(
        new Error('holder write failed'),
      );

      await expect(
        service.processTransaction(
          rawTransaction as any,
          SyncDirectionEnum.Live,
        ),
      ).rejects.toThrow('holder write failed');
      expect(tokenService.refreshTokenPrice).not.toHaveBeenCalled();
    });

    it('does not refresh outside live sync', async () => {
      await service.processTransaction(
        rawTransaction as any,
        SyncDirectionEnum.Backward,
      );

      expect(tokenService.refreshTokenPrice).not.toHaveBeenCalled();
    });

    it('does not refresh tokens outside a supported collection', async () => {
      transactionsService.isTokenSupportedCollection.mockResolvedValue(false);

      await service.processTransaction(
        rawTransaction as any,
        SyncDirectionEnum.Live,
      );

      expect(tokenService.refreshTokenPrice).not.toHaveBeenCalled();
    });
  });
});

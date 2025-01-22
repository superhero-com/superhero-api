import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { AePricingService } from './ae-pricing/ae-pricing.service';
import { TokenGatingService } from './ae/token-gating.service';
import { TX_FUNCTIONS } from './ae/utils/constants';
import { ACTIVE_NETWORK } from './ae/utils/networks';
import { IFactorySchema, ITransaction } from './ae/utils/types';
import { WebSocketService } from './ae/websocket.service';
import { BCL_CONTRACTS } from './configs';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from './tokens/queues/constants';
import {
  SAVE_TRANSACTION_QUEUE,
  SYNC_TRANSACTIONS_QUEUE,
  VALIDATE_TRANSACTIONS_QUEUE,
} from './transactions/queues/constants';

@Injectable()
export class AppService {
  tokens: string[] = [];
  constructor(
    private tokenGatingService: TokenGatingService,
    private websocketService: WebSocketService,
    private aePricingService: AePricingService,
    @InjectQueue(PULL_TOKEN_INFO_QUEUE)
    private readonly pullTokenPriceQueue: Queue,

    @InjectQueue(SAVE_TRANSACTION_QUEUE)
    private readonly saveTransactionQueue: Queue,

    @InjectQueue(SYNC_TRANSACTIONS_QUEUE)
    private readonly syncTransactionsQueue: Queue,

    @InjectQueue(SYNC_TOKENS_RANKS_QUEUE)
    private readonly syncTokensRanksQueue: Queue,

    @InjectQueue(SYNC_TOKEN_HOLDERS_QUEUE)
    private readonly syncTokenHoldersQueue: Queue,

    @InjectQueue(DELETE_OLD_TOKENS_QUEUE)
    private readonly deleteOldTokensQueue: Queue,

    @InjectQueue(VALIDATE_TRANSACTIONS_QUEUE)
    private readonly validateTransactionsQueue: Queue,
  ) {
    this.init();
  }

  async init() {
    await this.aePricingService.pullAndSaveCoinCurrencyRates();
    // clean all queue jobs
    await Promise.all([
      this.pullTokenPriceQueue.empty(),
      this.saveTransactionQueue.empty(),
      this.syncTransactionsQueue.empty(),
      this.syncTokensRanksQueue.empty(),
      this.syncTokenHoldersQueue.empty(),
      this.deleteOldTokensQueue.empty(),
      this.validateTransactionsQueue.empty(),
    ]);
    const contracts = BCL_CONTRACTS[ACTIVE_NETWORK.networkId];
    void this.deleteOldTokensQueue.add({
      factories: contracts.map((contract) => contract.contractId),
    });
    const factory = await this.tokenGatingService.getCurrentFactory();
    void this.loadFactory(factory);

    let syncedTransactions = [];

    this.websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
        if (
          transaction.tx.contractId &&
          Object.keys(TX_FUNCTIONS).includes(transaction.tx.function)
        ) {
          if (!syncedTransactions.includes(transaction.hash)) {
            syncedTransactions.push(transaction.hash);
            void this.saveTransactionQueue.add(
              {
                transaction,
                shouldBroadcast: true,
              },
              {
                jobId: transaction.hash,
              },
            );
          }
        }
      },
    );

    this.websocketService.subscribeForKeyBlocksUpdates((keyBlock) => {
      const desiredBlockHeight = keyBlock.height - 5;
      void this.validateTransactionsQueue.add({
        from: desiredBlockHeight - 10,
        to: desiredBlockHeight,
      });

      this.aePricingService.pullAndSaveCoinCurrencyRates();
      syncedTransactions = [];

      void this.syncTokensRanksQueue.add({});
    });
  }

  async loadFactory(factory: IFactorySchema) {
    const factoryInstance =
      await this.tokenGatingService.loadTokenGatingFactory(factory.address);

    for (const category of Object.keys(factory.categories)) {
      const registeredTokens =
        await factoryInstance.listRegisteredTokens(category);
      for (const [symbol, saleAddress] of Array.from(registeredTokens)) {
        this.tokens.push(saleAddress);
        console.log('TokenSaleService->dispatch::', symbol, saleAddress);
        this.loadTokenData(saleAddress as Encoded.ContractAddress);
      }
    }
  }

  loadTokenData(saleAddress: Encoded.ContractAddress) {
    void this.pullTokenPriceQueue.add(
      {
        saleAddress,
      },
      {
        jobId: `pull-price-${saleAddress}`,
        removeOnComplete: true,
      },
    );
  }

  /**
   * Retrieves the current version of the API from the package data.
   *
   * @returns {string} The version of the API.
   */
  getApiVersion() {
    return process.env.npm_package_version;
  }
}

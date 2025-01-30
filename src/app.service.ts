import { Encoded } from '@aeternity/aepp-sdk';
import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { AePricingService } from './ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { ICommunityFactorySchema, ITransaction } from './utils/types';
import { WebSocketService } from './ae/websocket.service';
import { TX_FUNCTIONS } from './configs';
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
  constructor(
    private communityFactoryService: CommunityFactoryService,
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

    const factory = await this.communityFactoryService.getCurrentFactory();
    void this.deleteOldTokensQueue.add({
      factories: [factory.address],
    });
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
                lifo: true,
              },
            );
          }
        } else if (syncedTransactions.length > 100) {
          syncedTransactions = [];
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

  async loadFactory(factory: ICommunityFactorySchema) {
    const factoryInstance = await this.communityFactoryService.loadFactory(
      factory.address,
    );

    for (const collection of Object.keys(factory.collections)) {
      const registeredTokens =
        await factoryInstance.listRegisteredTokens(collection);
      for (const [symbol, saleAddress] of Array.from(registeredTokens)) {
        console.log('BCLService->dispatch::', symbol, saleAddress);
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

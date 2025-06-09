import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { AePricingService } from './ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';
import { TX_FUNCTIONS } from './configs';
import { DELETE_OLD_TOKENS_QUEUE } from './tokens/queues/constants';
import {
  SAVE_TRANSACTION_QUEUE,
  VALIDATE_TRANSACTIONS_QUEUE,
} from './transactions/queues/constants';
import { ITransaction } from './utils/types';
import { Cron, CronExpression } from '@nestjs/schedule';
@Injectable()
export class AppService {
  constructor(
    private communityFactoryService: CommunityFactoryService,
    private websocketService: WebSocketService,
    private aePricingService: AePricingService,

    @InjectQueue(SAVE_TRANSACTION_QUEUE)
    private readonly saveTransactionQueue: Queue,

    @InjectQueue(DELETE_OLD_TOKENS_QUEUE)
    private readonly deleteOldTokensQueue: Queue,

    @InjectQueue(VALIDATE_TRANSACTIONS_QUEUE)
    private readonly validateTransactionsQueue: Queue,
  ) {
    this.init();
  }

  async init() {
    await this.aePricingService.pullAndSaveCoinCurrencyRates();

    const factory = await this.communityFactoryService.getCurrentFactory();
    await this.deleteOldTokensQueue.empty();
    void this.deleteOldTokensQueue.add({
      factories: [factory.address],
    });

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

    // this.websocketService.subscribeForKeyBlocksUpdates((keyBlock) => {
    //   const desiredBlockHeight = keyBlock.height - 5;
    //   void this.validateTransactionsQueue.add({
    //     from: desiredBlockHeight - 50,
    //     to: desiredBlockHeight,
    //   });

    //   this.aePricingService.pullAndSaveCoinCurrencyRates();
    //   syncedTransactions = [];
    // });
  }

  @Cron(CronExpression.EVERY_HOUR)
  syncAeCoinPricing() {
    this.aePricingService.pullAndSaveCoinCurrencyRates();
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

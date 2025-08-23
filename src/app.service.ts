import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bull';
import moment, { Moment } from 'moment';
import { AePricingService } from './ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';
import { SyncTransactionsService } from './bcl/services/sync-transactions.service';
import { PostService } from './social/services/post.service';
import { DELETE_OLD_TOKENS_QUEUE } from './tokens/queues/constants';
import { ITransaction } from './utils/types';

@Injectable()
export class AppService {
  startedAt: Moment;
  constructor(
    private communityFactoryService: CommunityFactoryService,
    private aePricingService: AePricingService,
    private websocketService: WebSocketService,
    private syncTransactionsService: SyncTransactionsService,
    private postService: PostService,

    @InjectQueue(DELETE_OLD_TOKENS_QUEUE)
    private readonly deleteOldTokensQueue: Queue,
  ) {
    this.init();
    this.startedAt = moment();
    this.setupLiveSync();
  }

  async init() {
    await this.aePricingService.pullAndSaveCoinCurrencyRates();

    const factory = await this.communityFactoryService.getCurrentFactory();
    await this.deleteOldTokensQueue.empty();
    void this.deleteOldTokensQueue.add({
      factories: [factory.address],
    });
  }

  setupLiveSync() {
    let syncedTransactions = [];

    this.websocketService.subscribeForTransactionsUpdates(
      (transaction: ITransaction) => {
        // Prevent duplicate transactions
        if (!syncedTransactions.includes(transaction.hash)) {
          this.syncTransactionsService.handleLiveTransaction(transaction);
          this.postService.handleLiveTransaction(transaction);
        }
        syncedTransactions.push(transaction.hash);

        // Reset synced transactions after 100 transactions
        if (syncedTransactions.length > 100) {
          syncedTransactions = [];
        }
      },
    );
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

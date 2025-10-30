import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import moment, { Moment } from 'moment';
import { AePricingService } from './ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';
@Injectable()
export class AppService {
  startedAt: Moment;
  constructor(
    private communityFactoryService: CommunityFactoryService,
    private aePricingService: AePricingService,
    private websocketService: WebSocketService,
  ) {
    this.init();
    this.startedAt = moment();
    this.setupLiveSync();
  }

  async init() {
    await this.aePricingService.pullAndSaveCoinCurrencyRates();
  }

  setupLiveSync() {
    // Live sync handlers are currently disabled
    // this.websocketService.subscribeForTransactionsUpdates(
    //   (transaction: ITransaction) => {
    //     // Prevent duplicate transactions
    //     if (!syncedTransactions.includes(transaction.hash)) {
    //       this.syncTransactionsService.handleLiveTransaction(transaction);
    //       this.postService.handleLiveTransaction(transaction);
    //       this.dexSyncService.handleLiveTransaction(transaction);
    //       this.tipService.handleLiveTransaction(transaction);
    //     }
    //     syncedTransactions.push(transaction.hash);
    //     // Reset synced transactions after 100 transactions
    //     if (syncedTransactions.length > 100) {
    //       syncedTransactions = [];
    //     }
    //   },
    // );
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

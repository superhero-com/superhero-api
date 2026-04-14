import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bull';
import moment, { Moment } from 'moment';
import { AePricingService } from './ae-pricing/ae-pricing.service';
import { CoinGeckoService } from './ae/coin-gecko.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { DELETE_OLD_TOKENS_QUEUE } from './tokens/queues/constants';

@Injectable()
export class AppService {
  startedAt: Moment;
  constructor(
    private communityFactoryService: CommunityFactoryService,
    private aePricingService: AePricingService,
    private coinGeckoService: CoinGeckoService,

    @InjectQueue(DELETE_OLD_TOKENS_QUEUE)
    private readonly deleteOldTokensQueue: Queue,
  ) {
    this.startedAt = moment();
    setTimeout(() => this.init(), 5_000);
  }

  async init() {
    const factory = await this.communityFactoryService.getCurrentFactory();
    await this.deleteOldTokensQueue.empty();
    void this.deleteOldTokensQueue.add({
      factories: [factory.address],
    });

    // Warm all CoinGecko caches (rates, market data, historical) on startup
    await this.coinGeckoService.syncAllFromApi();
    // Persist latest rates to the coin_prices DB table
    await this.aePricingService.pullAndSaveCoinCurrencyRates();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncAeCoinPricing() {
    // Fetch fresh data from CoinGecko and populate memory / Redis / DB caches
    await this.coinGeckoService.syncAllFromApi();
    // Persist latest rates snapshot to the coin_prices DB table
    await this.aePricingService.pullAndSaveCoinCurrencyRates();
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

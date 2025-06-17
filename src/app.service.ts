import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bull';
import { AePricingService } from './ae-pricing/ae-pricing.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { DELETE_OLD_TOKENS_QUEUE } from './tokens/queues/constants';
import moment, { Moment } from 'moment';
@Injectable()
export class AppService {
  startedAt: Moment;
  constructor(
    private communityFactoryService: CommunityFactoryService,
    private aePricingService: AePricingService,

    @InjectQueue(DELETE_OLD_TOKENS_QUEUE)
    private readonly deleteOldTokensQueue: Queue,
  ) {
    this.init();
    this.startedAt = moment();
  }

  async init() {
    await this.aePricingService.pullAndSaveCoinCurrencyRates();

    const factory = await this.communityFactoryService.getCurrentFactory();
    await this.deleteOldTokensQueue.empty();
    void this.deleteOldTokensQueue.add({
      factories: [factory.address],
    });
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

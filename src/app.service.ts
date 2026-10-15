import { InjectQueue } from '@nestjs/bull';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bull';
import moment, { Moment } from 'moment';
import { AePricingService } from './ae-pricing/ae-pricing.service';
import { CoinGeckoService } from './ae/coin-gecko.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { DELETE_OLD_TOKENS_QUEUE } from './tokens/queues/constants';

@Injectable()
export class AppService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private startupTimer?: NodeJS.Timeout;
  private stopped = false;
  startedAt: Moment;
  constructor(
    private communityFactoryService: CommunityFactoryService,
    private aePricingService: AePricingService,
    private coinGeckoService: CoinGeckoService,

    @InjectQueue(DELETE_OLD_TOKENS_QUEUE)
    private readonly deleteOldTokensQueue: Queue,
  ) {
    this.startedAt = moment();
  }

  onApplicationBootstrap() {
    this.startupTimer = setTimeout(() => {
      void this.init().catch((error: unknown) => {
        if (!this.stopped)
          this.logger.warn(
            'Startup warm-up did not complete',
            error instanceof Error ? error.message : String(error),
          );
      });
    }, 5_000);
    this.startupTimer.unref();
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.startupTimer);
  }

  async init() {
    if (this.stopped) return;
    const factory = await this.communityFactoryService.getCurrentFactory();
    if (this.stopped) return;
    await this.deleteOldTokensQueue.empty();
    if (this.stopped) return;
    await this.deleteOldTokensQueue.add({
      factories: [factory.address],
    });

    // Warm all CoinGecko caches (rates, market data, historical) on startup
    await this.syncAeCoinPricing();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncAeCoinPricing() {
    if (this.stopped) return;
    // Fetch fresh data from CoinGecko and populate memory / Redis / DB caches
    await this.coinGeckoService.syncAllFromApi();
    if (this.stopped) return;
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

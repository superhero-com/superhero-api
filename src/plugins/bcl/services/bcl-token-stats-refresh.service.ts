import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class BclTokenStatsRefreshService {
  private readonly logger = new Logger(BclTokenStatsRefreshService.name);
  private isRefreshing = false;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Refresh the materialized view every 10 minutes
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshTokenStatsView(): Promise<void> {
    if (this.isRefreshing) {
      this.logger.warn('Token stats refresh already in progress, skipping...');
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      this.logger.log('Refreshing bcl_token_stats materialized view...');
      
      await this.dataSource.query(
        `REFRESH MATERIALIZED VIEW CONCURRENTLY bcl_token_stats`,
      );

      const duration = Date.now() - startTime;
      this.logger.log(
        `Successfully refreshed bcl_token_stats materialized view in ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(
        'Failed to refresh bcl_token_stats materialized view',
        error.stack,
      );
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Manually trigger a refresh of the materialized view
   */
  async manualRefresh(): Promise<void> {
    await this.refreshTokenStatsView();
  }

  /**
   * Get the refresh status
   */
  isCurrentlyRefreshing(): boolean {
    return this.isRefreshing;
  }
}


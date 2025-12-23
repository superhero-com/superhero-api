import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class BclTokenPerformanceRefreshService {
  private readonly logger = new Logger(BclTokenPerformanceRefreshService.name);
  private isRefreshing = false;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Refresh the materialized view every 1 hour
   */
  @Cron(CronExpression.EVERY_HOUR)
  async refreshMaterializedView(): Promise<void> {
    if (this.isRefreshing) {
      this.logger.warn('BCL token performance view refresh already in progress, skipping...');
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      this.logger.log('Refreshing bcl_token_performance_view materialized view...');

      try {
        // Try concurrent refresh first (requires unique index)
        await this.dataSource.query(
          'REFRESH MATERIALIZED VIEW CONCURRENTLY bcl_token_performance_view',
        );
      } catch (concurrentError: any) {
        // If concurrent refresh fails, fall back to non-concurrent refresh
        const errorMessage =
          concurrentError?.message ||
          concurrentError?.driverError?.message ||
          '';
        const errorCode =
          concurrentError?.code || concurrentError?.driverError?.code || '';

        if (
          errorMessage.includes('cannot refresh materialized view') ||
          errorCode === '42883'
        ) {
          this.logger.warn(
            'Concurrent refresh not available (unique index may be missing), falling back to non-concurrent refresh',
          );
          await this.dataSource.query(
            'REFRESH MATERIALIZED VIEW bcl_token_performance_view',
          );
        } else {
          throw concurrentError;
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `BCL token performance materialized view refreshed successfully in ${duration}ms`,
      );
    } catch (error: any) {
      this.logger.error(
        'Failed to refresh BCL token performance materialized view',
        error.stack,
      );
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Manual refresh method that can be called from other services
   */
  async manualRefresh(): Promise<void> {
    await this.refreshMaterializedView();
  }

  /**
   * Get the refresh status
   */
  isCurrentlyRefreshing(): boolean {
    return this.isRefreshing;
  }
}


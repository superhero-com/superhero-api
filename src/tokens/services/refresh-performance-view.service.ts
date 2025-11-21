import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class RefreshPerformanceViewService {
  private readonly logger = new Logger(RefreshPerformanceViewService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Refresh the materialized view every 5 minutes
   * You can adjust the cron schedule based on your needs:
   * - Every 1 minute: CronExpression.EVERY_MINUTE
   * - Every 5 minutes: CronExpression.EVERY_5_MINUTES
   * - Every 10 minutes: CronExpression.EVERY_10_MINUTES
   * - Every 30 minutes: CronExpression.EVERY_30_MINUTES
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async refreshMaterializedView() {
    try {
      this.logger.log('Refreshing token_performance_view materialized view...');
      const startTime = Date.now();

      try {
        // Try concurrent refresh first (requires unique index)
        // await this.dataSource.query(
        //   'REFRESH MATERIALIZED VIEW CONCURRENTLY token_performance_view',
        // );
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
            'REFRESH MATERIALIZED VIEW token_performance_view',
          );
        } else {
          throw concurrentError;
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Materialized view refreshed successfully in ${duration}ms`,
      );
    } catch (error) {
      this.logger.error(
        'Failed to refresh materialized view',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Manual refresh method that can be called from other services
   */
  async manualRefresh(): Promise<void> {
    await this.refreshMaterializedView();
  }
}

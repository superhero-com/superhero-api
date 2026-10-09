import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  DELETE_STALE_TOKEN_PERFORMANCE_SQL,
  UPSERT_TOKEN_PERFORMANCE_SQL,
} from '../utils/token-performance-sql.util';

// Stable key shared by every instance; distinct from the other 1-arg keys (…746–…748).
export const REFRESH_TOKEN_PERFORMANCE_LOCK_KEY = 4019283749;

export interface TokenPerformanceRefreshResult {
  changed: number;
  removed: number;
}

@Injectable()
export class RefreshTokenPerformanceService {
  private readonly logger = new Logger(RefreshTokenPerformanceService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Returns null when another refresh holds the lock. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async refreshPerformance(): Promise<TokenPerformanceRefreshResult | null> {
    try {
      const startTime = Date.now();
      const result = await this.dataSource.transaction(async (manager) => {
        const [{ locked }] = await manager.query(
          'SELECT pg_try_advisory_xact_lock($1) AS locked',
          [REFRESH_TOKEN_PERFORMANCE_LOCK_KEY],
        );
        if (!locked) {
          return null;
        }
        const [{ count: removed }] = await manager.query(
          DELETE_STALE_TOKEN_PERFORMANCE_SQL,
        );
        const [{ count: changed }] = await manager.query(
          UPSERT_TOKEN_PERFORMANCE_SQL,
        );
        return { changed, removed };
      });

      if (result) {
        this.logger.log(
          `Refreshed token performance in ${Date.now() - startTime}ms ` +
            `(${result.changed} changed, ${result.removed} removed)`,
        );
      }
      return result;
    } catch (error) {
      this.logger.error(
        'Failed to refresh token performance',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }
}

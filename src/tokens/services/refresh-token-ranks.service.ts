import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { tryLockTokenMaintenance } from '../utils/token-maintenance-lock.util';

/**
 * Persists `token.rank` (market-cap rank among unlisted=false tokens) so
 * `queryTokensWithRanks` reads a plain column instead of recomputing
 * `RANK() OVER (...)` across the whole token table on every list request.
 */
@Injectable()
export class RefreshTokenRanksService {
  private readonly logger = new Logger(RefreshTokenRanksService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async refreshRanks() {
    try {
      const startTime = Date.now();

      const refreshed = await this.dataSource.transaction(async (manager) => {
        if (!(await tryLockTokenMaintenance(manager))) return false;

        await manager.query(`
        UPDATE "token"
        SET "rank" = ranked.rank
        FROM (
          SELECT
            sale_address,
            CAST(RANK() OVER (
              ORDER BY
                CASE WHEN market_cap = 0 THEN 1 ELSE 0 END,
                market_cap DESC,
                created_at ASC
            ) AS INTEGER) AS rank
          FROM "token"
          WHERE unlisted = false
        ) ranked
        WHERE "token".sale_address = ranked.sale_address
          AND "token".rank IS DISTINCT FROM ranked.rank
        `);
        return true;
      });

      if (!refreshed) return;

      this.logger.log(`Refreshed token ranks in ${Date.now() - startTime}ms`);
    } catch (error) {
      this.logger.error(
        'Failed to refresh token ranks',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async manualRefresh(): Promise<void> {
    await this.refreshRanks();
  }
}

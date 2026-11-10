import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Persists the market-cap rank among unlisted=false tokens into `token_rank`,
 * so token lists read a plain column instead of recomputing
 * `RANK() OVER (...)` across the whole token table on every request.
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

      // Not INSERT ... ON CONFLICT DO UPDATE ... WHERE: that locks every
      // conflicting row even when the WHERE is false, writing WAL for the
      // whole table on every tick. Rows of unlisted tokens are left alone and
      // rows of deleted tokens go with them (ON DELETE CASCADE).
      await this.dataSource.query(`
        WITH ranked AS (
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
        ),
        updated AS (
          UPDATE "token_rank"
          SET "rank" = ranked.rank
          FROM ranked
          WHERE "token_rank".sale_address = ranked.sale_address
            AND "token_rank".rank IS DISTINCT FROM ranked.rank
        )
        INSERT INTO "token_rank" (sale_address, rank)
        SELECT ranked.sale_address, ranked.rank
        FROM ranked
        WHERE NOT EXISTS (
          SELECT 1
          FROM "token_rank"
          WHERE "token_rank".sale_address = ranked.sale_address
        )
        ON CONFLICT (sale_address) DO NOTHING
      `);

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

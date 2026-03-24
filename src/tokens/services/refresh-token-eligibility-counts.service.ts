import { TOKEN_HASHTAG_REGEX_SOURCE } from '@/social/utils/token-mentions-sql.util';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { TRENDING_SCORE_CONFIG } from '@/configs';
import { DataSource } from 'typeorm';

@Injectable()
export class RefreshTokenEligibilityCountsService {
  private static readonly ENSURE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS token_eligibility_counts (
      symbol varchar PRIMARY KEY,
      post_count integer NOT NULL DEFAULT 0,
      stored_post_count integer NOT NULL DEFAULT 0,
      content_post_count integer NOT NULL DEFAULT 0,
      refreshed_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    )
  `;
  private readonly logger = new Logger(
    RefreshTokenEligibilityCountsService.name,
  );
  private isRefreshing = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.refreshSafely('startup');
  }

  @Cron(TRENDING_SCORE_CONFIG.ELIGIBILITY_COUNTS_REFRESH_CRON)
  async refreshScheduled() {
    await this.refreshSafely('scheduled');
  }

  async manualRefresh(): Promise<void> {
    await this.refreshSafely('manual');
  }

  private async refreshSafely(trigger: string): Promise<void> {
    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      await this.ensureTableExists();
      await this.dataSource.transaction(async (manager) => {
        await manager.query('TRUNCATE TABLE token_eligibility_counts');
        await manager.query(`
          INSERT INTO token_eligibility_counts (
            symbol,
            post_count,
            stored_post_count,
            content_post_count,
            refreshed_at
          )
          SELECT
            matched.symbol,
            COUNT(DISTINCT matched.post_id) AS post_count,
            COUNT(DISTINCT matched.post_id) FILTER (
              WHERE matched.match_source = 'stored'
            ) AS stored_post_count,
            COUNT(DISTINCT matched.post_id) FILTER (
              WHERE matched.match_source = 'content'
            ) AS content_post_count,
            CURRENT_TIMESTAMP(6) AS refreshed_at
          FROM (
            SELECT
              post.id AS post_id,
              UPPER(mention.symbol) AS symbol,
              'stored' AS match_source
            FROM posts post
            CROSS JOIN LATERAL jsonb_array_elements_text(
              COALESCE(post.token_mentions, '[]'::jsonb)
            ) AS mention(symbol)
            WHERE post.is_hidden = false
              AND mention.symbol <> ''

            UNION ALL

            SELECT
              post.id AS post_id,
              UPPER(content_match[1]) AS symbol,
              'content' AS match_source
            FROM posts post
            CROSS JOIN LATERAL regexp_matches(
              COALESCE(post.content, ''),
              '${TOKEN_HASHTAG_REGEX_SOURCE}',
              'g'
            ) AS content_match
            WHERE post.is_hidden = false
              AND jsonb_array_length(COALESCE(post.token_mentions, '[]'::jsonb)) = 0
          ) matched
          GROUP BY matched.symbol
        `);
      });

      const [{ count }] = await this.dataSource.query(`
        SELECT COUNT(*)::int AS count
        FROM token_eligibility_counts
      `);

      this.logger.log(
        `Refreshed token eligibility counts via ${trigger} in ${
          Date.now() - startTime
        }ms (${count} symbols)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to refresh token eligibility counts via ${trigger}`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isRefreshing = false;
    }
  }

  private async ensureTableExists(): Promise<void> {
    await this.dataSource.query(
      RefreshTokenEligibilityCountsService.ENSURE_TABLE_SQL,
    );
  }
}

import { TOKEN_HASHTAG_REGEX_SOURCE } from '@/social/utils/token-mentions-sql.util';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { TRENDING_SCORE_CONFIG } from '@/configs';
import { runWithDatabaseIssueLogging } from '@/utils/database-issue-logging';
import { DataSource } from 'typeorm';

const TOKEN_ELIGIBILITY_REFRESH_STATE_ID = 'default';
type QueryExecutor = {
  query: (sql: string, params?: any[]) => Promise<any>;
};

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
  private static readonly ENSURE_STATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS token_eligibility_refresh_state (
      id varchar PRIMARY KEY,
      last_processed_created_at timestamp NULL,
      last_processed_post_id varchar NULL,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    )
  `;
  private readonly logger = new Logger(
    RefreshTokenEligibilityCountsService.name,
  );
  // NOTE: This only prevents overlap inside a single Node process.
  // In multi-instance deployments, concurrent incremental refreshes can still
  // race and double-count deltas unless a shared/distributed lock is added.
  private isRefreshing = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.ensureTableExists();

    const state = await this.loadRefreshState();
    if (!state?.last_processed_created_at) {
      this.logger.warn(
        'Skipping startup token eligibility refresh because no watermark exists yet; run a manual refresh off-peak to backfill historical counts.',
      );
      return;
    }

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
    let processedPosts = 0;

    try {
      await this.ensureTableExists();
      await runWithDatabaseIssueLogging({
        logger: this.logger,
        stage: 'token eligibility refresh transaction',
        context: {
          trigger,
        },
        operation: () =>
          this.dataSource.transaction(async (manager) => {
            const state = await this.loadRefreshState(manager);

            if (!state?.last_processed_created_at) {
              processedPosts = await this.rebuildAllCounts(manager);
              return;
            }

            const [latestUnprocessedPost] = await manager.query(
              `
                SELECT post.created_at, post.id
                FROM posts post
                WHERE post.created_at > $1
                   OR (post.created_at = $1 AND post.id > $2)
                ORDER BY post.created_at DESC, post.id DESC
                LIMIT 1
              `,
              [
                state.last_processed_created_at,
                state.last_processed_post_id || '',
              ],
            );

            if (!latestUnprocessedPost) {
              return;
            }

            const [{ processed_count }] = await manager.query(
              `
                SELECT COUNT(*)::int AS processed_count
                FROM posts post
                WHERE (
                  post.created_at > $1
                  OR (post.created_at = $1 AND post.id > $2)
                )
                  AND (
                    post.created_at < $3
                    OR (post.created_at = $3 AND post.id <= $4)
                  )
              `,
              [
                state.last_processed_created_at,
                state.last_processed_post_id || '',
                latestUnprocessedPost.created_at,
                latestUnprocessedPost.id,
              ],
            );
            processedPosts = Number(processed_count || 0);

            await manager.query(
              `
                INSERT INTO token_eligibility_counts (
                  symbol,
                  post_count,
                  stored_post_count,
                  content_post_count,
                  refreshed_at
                )
                WITH matched AS (
                  SELECT DISTINCT
                    post.id AS post_id,
                    UPPER(mention.symbol) AS symbol,
                    'stored' AS match_source
                  FROM posts post
                  CROSS JOIN LATERAL jsonb_array_elements_text(
                    COALESCE(post.token_mentions, '[]'::jsonb)
                  ) AS mention(symbol)
                  WHERE (
                    post.created_at > $1
                    OR (post.created_at = $1 AND post.id > $2)
                  )
                    AND (
                      post.created_at < $3
                      OR (post.created_at = $3 AND post.id <= $4)
                    )
                    AND post.is_hidden = false
                    AND mention.symbol <> ''

                  UNION ALL

                  SELECT DISTINCT
                    post.id AS post_id,
                    UPPER(content_match[1]) AS symbol,
                    'content' AS match_source
                  FROM posts post
                  CROSS JOIN LATERAL regexp_matches(
                    COALESCE(post.content, ''),
                    '${TOKEN_HASHTAG_REGEX_SOURCE}',
                    'g'
                  ) AS content_match
                  WHERE (
                    post.created_at > $1
                    OR (post.created_at = $1 AND post.id > $2)
                  )
                    AND (
                      post.created_at < $3
                      OR (post.created_at = $3 AND post.id <= $4)
                    )
                    AND post.is_hidden = false
                    AND jsonb_array_length(COALESCE(post.token_mentions, '[]'::jsonb)) = 0
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
                FROM matched
                GROUP BY matched.symbol
                ON CONFLICT (symbol) DO UPDATE
                SET
                  post_count = token_eligibility_counts.post_count + EXCLUDED.post_count,
                  stored_post_count = token_eligibility_counts.stored_post_count + EXCLUDED.stored_post_count,
                  content_post_count = token_eligibility_counts.content_post_count + EXCLUDED.content_post_count,
                  refreshed_at = EXCLUDED.refreshed_at
              `,
              [
                state.last_processed_created_at,
                state.last_processed_post_id || '',
                latestUnprocessedPost.created_at,
                latestUnprocessedPost.id,
              ],
            );

            await this.upsertRefreshState(
              manager,
              latestUnprocessedPost.created_at,
              latestUnprocessedPost.id,
            );
          }),
      });

      const [{ count }] = await runWithDatabaseIssueLogging({
        logger: this.logger,
        stage: 'token eligibility refresh summary count',
        context: {
          trigger,
          processedPosts,
        },
        operation: () =>
          this.dataSource.query(`
            SELECT COUNT(*)::int AS count
            FROM token_eligibility_counts
          `),
      });

      this.logger.log(
        `Refreshed token eligibility counts via ${trigger} in ${
          Date.now() - startTime
        }ms (${count} symbols, ${processedPosts} posts processed)`,
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
    await runWithDatabaseIssueLogging({
      logger: this.logger,
      stage: 'token eligibility ensure counts table',
      context: {},
      operation: () =>
        this.dataSource.query(
          RefreshTokenEligibilityCountsService.ENSURE_TABLE_SQL,
        ),
    });
    await runWithDatabaseIssueLogging({
      logger: this.logger,
      stage: 'token eligibility ensure refresh state table',
      context: {},
      operation: () =>
        this.dataSource.query(
          RefreshTokenEligibilityCountsService.ENSURE_STATE_TABLE_SQL,
        ),
    });
  }

  private async loadRefreshState(
    executor: QueryExecutor = this.dataSource,
  ): Promise<
    | {
        last_processed_created_at: string | Date | null;
        last_processed_post_id: string | null;
      }
    | undefined
  > {
    const [state] = await executor.query(
      `
        SELECT last_processed_created_at, last_processed_post_id
        FROM token_eligibility_refresh_state
        WHERE id = $1
      `,
      [TOKEN_ELIGIBILITY_REFRESH_STATE_ID],
    );

    return state;
  }

  private async rebuildAllCounts(manager: QueryExecutor): Promise<number> {
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
        SELECT DISTINCT
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

        SELECT DISTINCT
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

    const [latestPost] = await manager.query(`
      SELECT post.created_at, post.id
      FROM posts post
      ORDER BY post.created_at DESC, post.id DESC
      LIMIT 1
    `);
    const [{ total_posts }] = await manager.query(`
      SELECT COUNT(*)::int AS total_posts
      FROM posts
    `);

    if (latestPost) {
      await this.upsertRefreshState(
        manager,
        latestPost.created_at,
        latestPost.id,
      );
    }

    return Number(total_posts || 0);
  }

  private async upsertRefreshState(
    manager: QueryExecutor,
    lastProcessedCreatedAt: string | Date,
    lastProcessedPostId: string,
  ): Promise<void> {
    await manager.query(
      `
        INSERT INTO token_eligibility_refresh_state (
          id,
          last_processed_created_at,
          last_processed_post_id,
          updated_at
        )
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP(6))
        ON CONFLICT (id) DO UPDATE
        SET
          last_processed_created_at = EXCLUDED.last_processed_created_at,
          last_processed_post_id = EXCLUDED.last_processed_post_id,
          updated_at = CURRENT_TIMESTAMP(6)
      `,
      [
        TOKEN_ELIGIBILITY_REFRESH_STATE_ID,
        lastProcessedCreatedAt,
        lastProcessedPostId,
      ],
    );
  }
}

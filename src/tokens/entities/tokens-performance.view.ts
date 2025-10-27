import { ViewColumn, ViewEntity } from 'typeorm';
import { Token } from './token.entity';

/**
 * TokenPerformanceView - A database view for efficient batch queries and JOINs
 * 
 * This view is designed for:
 * - Fetching performance data for multiple tokens at once
 * - LEFT JOIN with tokens when fetching token lists
 * - LEFT JOIN with topics/posts that reference tokens
 * 
 * Usage:
 * ```typescript
 * // Get all tokens with performance
 * const tokens = await tokenRepo
 *   .createQueryBuilder('token')
 *   .leftJoinAndSelect('token.performance_view', 'perf_view')
 *   .getMany();
 * 
 * // Get posts with token performance
 * const posts = await postRepo
 *   .createQueryBuilder('post')
 *   .leftJoin('post.topics', 'topic')
 *   .leftJoin('topic.token', 'token')
 *   .leftJoin('token.performance_view', 'perf')
 *   .getMany();
 * ```
 */
@ViewEntity({
  name: 'token_performance_view',
  synchronize: true,
  expression: `
    SELECT
      t.sale_address,
      -- Past 24h
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '24 hours'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY created_at ASC
          LIMIT 1
        ) x
      ) as past_24h,
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '24 hours'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY CAST(tx.buy_price->>'ae' AS NUMERIC) DESC, created_at ASC
          LIMIT 1
        ) x
      ) as past_24h_high,
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '24 hours'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY CAST(tx.buy_price->>'ae' AS NUMERIC) ASC, created_at ASC
          LIMIT 1
        ) x
      ) as past_24h_low,
      -- Past 7d
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '7 days'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY created_at ASC
          LIMIT 1
        ) x
      ) as past_7d,
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '7 days'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY CAST(tx.buy_price->>'ae' AS NUMERIC) DESC, created_at ASC
          LIMIT 1
        ) x
      ) as past_7d_high,
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '7 days'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY CAST(tx.buy_price->>'ae' AS NUMERIC) ASC, created_at ASC
          LIMIT 1
        ) x
      ) as past_7d_low,
      -- Past 30d
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '30 days'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY created_at ASC
          LIMIT 1
        ) x
      ) as past_30d,
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '30 days'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY CAST(tx.buy_price->>'ae' AS NUMERIC) DESC, created_at ASC
          LIMIT 1
        ) x
      ) as past_30d_high,
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '30 days'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY CAST(tx.buy_price->>'ae' AS NUMERIC) ASC, created_at ASC
          LIMIT 1
        ) x
      ) as past_30d_low,
      -- All time
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY created_at ASC
          LIMIT 1
        ) x
      ) as all_time_first,
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY CAST(tx.buy_price->>'ae' AS NUMERIC) DESC, created_at ASC
          LIMIT 1
        ) x
      ) as all_time_high,
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY CAST(tx.buy_price->>'ae' AS NUMERIC) ASC, created_at ASC
          LIMIT 1
        ) x
      ) as all_time_low
    FROM token t
    WHERE EXISTS (
      SELECT 1
      FROM transactions tx
      WHERE tx.sale_address = t.sale_address
    )
  `,
})
export class TokenPerformanceView {
  @ViewColumn()
  sale_address: string;

  // Past 24h data
  @ViewColumn()
  past_24h: {
    buy_price: any;
    created_at: Date;
  } | null;

  @ViewColumn()
  past_24h_high: {
    buy_price: any;
    created_at: Date;
  } | null;

  @ViewColumn()
  past_24h_low: {
    buy_price: any;
    created_at: Date;
  } | null;

  // Past 7d data
  @ViewColumn()
  past_7d: {
    buy_price: any;
    created_at: Date;
  } | null;

  @ViewColumn()
  past_7d_high: {
    buy_price: any;
    created_at: Date;
  } | null;

  @ViewColumn()
  past_7d_low: {
    buy_price: any;
    created_at: Date;
  } | null;

  // Past 30d data
  @ViewColumn()
  past_30d: {
    buy_price: any;
    created_at: Date;
  } | null;

  @ViewColumn()
  past_30d_high: {
    buy_price: any;
    created_at: Date;
  } | null;

  @ViewColumn()
  past_30d_low: {
    buy_price: any;
    created_at: Date;
  } | null;

  // All time data
  @ViewColumn()
  all_time_first: {
    buy_price: any;
    created_at: Date;
  } | null;

  @ViewColumn()
  all_time_high: {
    buy_price: any;
    created_at: Date;
  } | null;

  @ViewColumn()
  all_time_low: {
    buy_price: any;
    created_at: Date;
  } | null;
}


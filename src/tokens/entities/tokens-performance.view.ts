import { Index, ViewColumn, ViewEntity } from 'typeorm';

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
  materialized: true,
  synchronize: true,
  expression: `
    WITH base_data AS (
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
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '24 hours'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) x
      ) as past_24h_latest,
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
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '7 days'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) x
      ) as past_7d_latest,
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
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.created_at > NOW() - INTERVAL '30 days'
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) x
      ) as past_30d_latest,
      -- All time
      (
        SELECT row_to_json(x)
        FROM (
          SELECT buy_price, created_at
          FROM transactions tx
          WHERE tx.sale_address = t.sale_address
            AND tx.buy_price->>'ae' != 'NaN'
            AND tx.buy_price->>'ae' IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) x
      ) as all_time_latest,
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
    )
    SELECT
      sale_address,
      -- Grouped past_24h object
      json_build_object(
        'current', past_24h_latest->'buy_price',
        'current_date', past_24h_latest->>'created_at',
        'current_change',
          CASE
            WHEN past_24h_latest->>'buy_price' IS NOT NULL
              AND past_24h->>'buy_price' IS NOT NULL
            THEN CAST(past_24h_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) - CAST(past_24h->'buy_price'->>'ae' AS DOUBLE PRECISION)
            ELSE NULL
          END,
        'current_change_percent',
          CASE
            WHEN past_24h_latest->>'buy_price' IS NOT NULL
              AND past_24h->>'buy_price' IS NOT NULL
              AND CAST(past_24h->'buy_price'->>'ae' AS DOUBLE PRECISION) != 0
            THEN ((CAST(past_24h_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) - CAST(past_24h->'buy_price'->>'ae' AS DOUBLE PRECISION)) / CAST(past_24h->'buy_price'->>'ae' AS DOUBLE PRECISION)) * 100
            ELSE NULL
          END,
        'current_change_direction',
          CASE
            WHEN past_24h_latest->>'buy_price' IS NOT NULL
              AND past_24h->>'buy_price' IS NOT NULL
            THEN
              CASE
                WHEN CAST(past_24h_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) > CAST(past_24h->'buy_price'->>'ae' AS DOUBLE PRECISION) THEN 'up'
                WHEN CAST(past_24h_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) < CAST(past_24h->'buy_price'->>'ae' AS DOUBLE PRECISION) THEN 'down'
                ELSE 'neutral'
              END
            ELSE NULL
          END,
        'high', past_24h_high->'buy_price',
        'high_date', past_24h_high->>'created_at',
        'low', past_24h_low->'buy_price',
        'low_date', past_24h_low->>'created_at',
        'last_updated', past_24h_latest->>'created_at'
      ) as past_24h,
      -- Grouped past_7d object
      json_build_object(
        'current', past_7d_latest->'buy_price',
        'current_date', past_7d_latest->>'created_at',
        'current_change',
          CASE
            WHEN past_7d_latest->>'buy_price' IS NOT NULL
              AND past_7d->>'buy_price' IS NOT NULL
            THEN CAST(past_7d_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) - CAST(past_7d->'buy_price'->>'ae' AS DOUBLE PRECISION)
            ELSE NULL
          END,
        'current_change_percent',
          CASE
            WHEN past_7d_latest->>'buy_price' IS NOT NULL
              AND past_7d->>'buy_price' IS NOT NULL
              AND CAST(past_7d->'buy_price'->>'ae' AS DOUBLE PRECISION) != 0
            THEN ((CAST(past_7d_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) - CAST(past_7d->'buy_price'->>'ae' AS DOUBLE PRECISION)) / CAST(past_7d->'buy_price'->>'ae' AS DOUBLE PRECISION)) * 100
            ELSE NULL
          END,
        'current_change_direction',
          CASE
            WHEN past_7d_latest->>'buy_price' IS NOT NULL
              AND past_7d->>'buy_price' IS NOT NULL
            THEN
              CASE
                WHEN CAST(past_7d_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) > CAST(past_7d->'buy_price'->>'ae' AS DOUBLE PRECISION) THEN 'up'
                WHEN CAST(past_7d_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) < CAST(past_7d->'buy_price'->>'ae' AS DOUBLE PRECISION) THEN 'down'
                ELSE 'neutral'
              END
            ELSE NULL
          END,
        'high', past_7d_high->'buy_price',
        'high_date', past_7d_high->>'created_at',
        'low', past_7d_low->'buy_price',
        'low_date', past_7d_low->>'created_at',
        'last_updated', past_7d_latest->>'created_at'
      ) as past_7d,
      -- Grouped past_30d object
      json_build_object(
        'current', past_30d_latest->'buy_price',
        'current_date', past_30d_latest->>'created_at',
        'current_change',
          CASE
            WHEN past_30d_latest->>'buy_price' IS NOT NULL
              AND past_30d->>'buy_price' IS NOT NULL
            THEN CAST(past_30d_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) - CAST(past_30d->'buy_price'->>'ae' AS DOUBLE PRECISION)
            ELSE NULL
          END,
        'current_change_percent',
          CASE
            WHEN past_30d_latest->>'buy_price' IS NOT NULL
              AND past_30d->>'buy_price' IS NOT NULL
              AND CAST(past_30d->'buy_price'->>'ae' AS DOUBLE PRECISION) != 0
            THEN ((CAST(past_30d_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) - CAST(past_30d->'buy_price'->>'ae' AS DOUBLE PRECISION)) / CAST(past_30d->'buy_price'->>'ae' AS DOUBLE PRECISION)) * 100
            ELSE NULL
          END,
        'current_change_direction',
          CASE
            WHEN past_30d_latest->>'buy_price' IS NOT NULL
              AND past_30d->>'buy_price' IS NOT NULL
            THEN
              CASE
                WHEN CAST(past_30d_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) > CAST(past_30d->'buy_price'->>'ae' AS DOUBLE PRECISION) THEN 'up'
                WHEN CAST(past_30d_latest->'buy_price'->>'ae' AS DOUBLE PRECISION) < CAST(past_30d->'buy_price'->>'ae' AS DOUBLE PRECISION) THEN 'down'
                ELSE 'neutral'
              END
            ELSE NULL
          END,
        'high', past_30d_high->'buy_price',
        'high_date', past_30d_high->>'created_at',
        'low', past_30d_low->'buy_price',
        'low_date', past_30d_low->>'created_at',
        'last_updated', past_30d_latest->>'created_at'
      ) as past_30d,
      -- Grouped all_time object
      json_build_object(
        'current', all_time_latest->'buy_price',
        'current_date', all_time_latest->>'created_at',
        'high', all_time_high->'buy_price',
        'high_date', all_time_high->>'created_at',
        'low', all_time_low->'buy_price',
        'low_date', all_time_low->>'created_at'
      ) as all_time
    FROM base_data
  `,
})
export class TokenPerformanceView {
  @ViewColumn()
  @Index({ unique: true })
  sale_address: string;

  @ViewColumn()
  past_24h: {
    current: any;
    current_date: Date;
    current_change: number | null;
    current_change_percent: number | null;
    current_change_direction: 'up' | 'down' | 'neutral' | null;
    high: any;
    high_date: Date;
    low: any;
    low_date: Date;
    last_updated: Date;
  } | null;

  @ViewColumn()
  past_7d: {
    current: any;
    current_date: Date;
    current_change: number | null;
    current_change_percent: number | null;
    current_change_direction: 'up' | 'down' | 'neutral' | null;
    high: any;
    high_date: Date;
    low: any;
    low_date: Date;
    last_updated: Date;
  } | null;

  @ViewColumn()
  past_30d: {
    current: any;
    current_date: Date;
    current_change: number | null;
    current_change_percent: number | null;
    current_change_direction: 'up' | 'down' | 'neutral' | null;
    high: any;
    high_date: Date;
    low: any;
    low_date: Date;
    last_updated: Date;
  } | null;

  @ViewColumn()
  all_time: {
    current: any;
    current_date: Date;
    high: any;
    high_date: Date;
    low: any;
    low_date: Date;
  } | null;
}

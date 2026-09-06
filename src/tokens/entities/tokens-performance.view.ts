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
    WITH valid_tx AS (
      SELECT
        tx.sale_address,
        tx.buy_price,
        tx.created_at,
        CAST(tx.buy_price->>'ae' AS NUMERIC) AS price_ae
      FROM transactions tx
      WHERE tx.buy_price->>'ae' IS NOT NULL
        AND tx.buy_price->>'ae' != 'NaN'
    ),
    volumes AS (
      SELECT
        tx.sale_address,
        SUM(tx.volume) FILTER (WHERE tx.created_at > NOW() - INTERVAL '24 hours') AS volume_24h,
        SUM(tx.volume) FILTER (WHERE tx.created_at > NOW() - INTERVAL '7 days') AS volume_7d,
        SUM(tx.volume) FILTER (WHERE tx.created_at > NOW() - INTERVAL '30 days') AS volume_30d
      FROM transactions tx
      GROUP BY tx.sale_address
    ),
    ranked_24h AS (
      SELECT
        sale_address,
        buy_price,
        created_at,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY created_at ASC) AS r_first,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY created_at DESC) AS r_last,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY price_ae DESC, created_at ASC) AS r_high,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY price_ae ASC, created_at ASC) AS r_low
      FROM valid_tx
      WHERE created_at > NOW() - INTERVAL '24 hours'
    ),
    agg_24h AS (
      SELECT
        sale_address,
        MIN(created_at) FILTER (WHERE r_first = 1) AS first_at,
        (array_agg(buy_price) FILTER (WHERE r_first = 1))[1] AS first_price,
        MIN(created_at) FILTER (WHERE r_last = 1) AS latest_at,
        (array_agg(buy_price) FILTER (WHERE r_last = 1))[1] AS latest_price,
        MIN(created_at) FILTER (WHERE r_high = 1) AS high_at,
        (array_agg(buy_price) FILTER (WHERE r_high = 1))[1] AS high_price,
        MIN(created_at) FILTER (WHERE r_low = 1) AS low_at,
        (array_agg(buy_price) FILTER (WHERE r_low = 1))[1] AS low_price
      FROM ranked_24h
      WHERE r_first = 1 OR r_last = 1 OR r_high = 1 OR r_low = 1
      GROUP BY sale_address
    ),
    ranked_7d AS (
      SELECT
        sale_address,
        buy_price,
        created_at,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY created_at ASC) AS r_first,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY created_at DESC) AS r_last,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY price_ae DESC, created_at ASC) AS r_high,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY price_ae ASC, created_at ASC) AS r_low
      FROM valid_tx
      WHERE created_at > NOW() - INTERVAL '7 days'
    ),
    agg_7d AS (
      SELECT
        sale_address,
        MIN(created_at) FILTER (WHERE r_first = 1) AS first_at,
        (array_agg(buy_price) FILTER (WHERE r_first = 1))[1] AS first_price,
        MIN(created_at) FILTER (WHERE r_last = 1) AS latest_at,
        (array_agg(buy_price) FILTER (WHERE r_last = 1))[1] AS latest_price,
        MIN(created_at) FILTER (WHERE r_high = 1) AS high_at,
        (array_agg(buy_price) FILTER (WHERE r_high = 1))[1] AS high_price,
        MIN(created_at) FILTER (WHERE r_low = 1) AS low_at,
        (array_agg(buy_price) FILTER (WHERE r_low = 1))[1] AS low_price
      FROM ranked_7d
      WHERE r_first = 1 OR r_last = 1 OR r_high = 1 OR r_low = 1
      GROUP BY sale_address
    ),
    ranked_30d AS (
      SELECT
        sale_address,
        buy_price,
        created_at,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY created_at ASC) AS r_first,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY created_at DESC) AS r_last,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY price_ae DESC, created_at ASC) AS r_high,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY price_ae ASC, created_at ASC) AS r_low
      FROM valid_tx
      WHERE created_at > NOW() - INTERVAL '30 days'
    ),
    agg_30d AS (
      SELECT
        sale_address,
        MIN(created_at) FILTER (WHERE r_first = 1) AS first_at,
        (array_agg(buy_price) FILTER (WHERE r_first = 1))[1] AS first_price,
        MIN(created_at) FILTER (WHERE r_last = 1) AS latest_at,
        (array_agg(buy_price) FILTER (WHERE r_last = 1))[1] AS latest_price,
        MIN(created_at) FILTER (WHERE r_high = 1) AS high_at,
        (array_agg(buy_price) FILTER (WHERE r_high = 1))[1] AS high_price,
        MIN(created_at) FILTER (WHERE r_low = 1) AS low_at,
        (array_agg(buy_price) FILTER (WHERE r_low = 1))[1] AS low_price
      FROM ranked_30d
      WHERE r_first = 1 OR r_last = 1 OR r_high = 1 OR r_low = 1
      GROUP BY sale_address
    ),
    ranked_all AS (
      SELECT
        sale_address,
        buy_price,
        created_at,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY created_at DESC) AS r_last,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY price_ae DESC, created_at ASC) AS r_high,
        ROW_NUMBER() OVER (PARTITION BY sale_address ORDER BY price_ae ASC, created_at ASC) AS r_low
      FROM valid_tx
    ),
    agg_all AS (
      SELECT
        sale_address,
        MIN(created_at) FILTER (WHERE r_last = 1) AS latest_at,
        (array_agg(buy_price) FILTER (WHERE r_last = 1))[1] AS latest_price,
        MIN(created_at) FILTER (WHERE r_high = 1) AS high_at,
        (array_agg(buy_price) FILTER (WHERE r_high = 1))[1] AS high_price,
        MIN(created_at) FILTER (WHERE r_low = 1) AS low_at,
        (array_agg(buy_price) FILTER (WHERE r_low = 1))[1] AS low_price
      FROM ranked_all
      WHERE r_last = 1 OR r_high = 1 OR r_low = 1
      GROUP BY sale_address
    ),
    base_data AS (
      SELECT
        t.sale_address,
        CASE WHEN a24.first_at IS NULL THEN NULL ELSE json_build_object('buy_price', a24.first_price, 'created_at', a24.first_at) END as past_24h,
        CASE WHEN a24.high_at IS NULL THEN NULL ELSE json_build_object('buy_price', a24.high_price, 'created_at', a24.high_at) END as past_24h_high,
        CASE WHEN a24.low_at IS NULL THEN NULL ELSE json_build_object('buy_price', a24.low_price, 'created_at', a24.low_at) END as past_24h_low,
        CASE WHEN a24.latest_at IS NULL THEN NULL ELSE json_build_object('buy_price', a24.latest_price, 'created_at', a24.latest_at) END as past_24h_latest,
        v.volume_24h,
        v.volume_7d,
        v.volume_30d,
        CASE WHEN a7.first_at IS NULL THEN NULL ELSE json_build_object('buy_price', a7.first_price, 'created_at', a7.first_at) END as past_7d,
        CASE WHEN a7.high_at IS NULL THEN NULL ELSE json_build_object('buy_price', a7.high_price, 'created_at', a7.high_at) END as past_7d_high,
        CASE WHEN a7.low_at IS NULL THEN NULL ELSE json_build_object('buy_price', a7.low_price, 'created_at', a7.low_at) END as past_7d_low,
        CASE WHEN a7.latest_at IS NULL THEN NULL ELSE json_build_object('buy_price', a7.latest_price, 'created_at', a7.latest_at) END as past_7d_latest,
        CASE WHEN a30.first_at IS NULL THEN NULL ELSE json_build_object('buy_price', a30.first_price, 'created_at', a30.first_at) END as past_30d,
        CASE WHEN a30.high_at IS NULL THEN NULL ELSE json_build_object('buy_price', a30.high_price, 'created_at', a30.high_at) END as past_30d_high,
        CASE WHEN a30.low_at IS NULL THEN NULL ELSE json_build_object('buy_price', a30.low_price, 'created_at', a30.low_at) END as past_30d_low,
        CASE WHEN a30.latest_at IS NULL THEN NULL ELSE json_build_object('buy_price', a30.latest_price, 'created_at', a30.latest_at) END as past_30d_latest,
        CASE WHEN aall.latest_at IS NULL THEN NULL ELSE json_build_object('buy_price', aall.latest_price, 'created_at', aall.latest_at) END as all_time_latest,
        CASE WHEN aall.high_at IS NULL THEN NULL ELSE json_build_object('buy_price', aall.high_price, 'created_at', aall.high_at) END as all_time_high,
        CASE WHEN aall.low_at IS NULL THEN NULL ELSE json_build_object('buy_price', aall.low_price, 'created_at', aall.low_at) END as all_time_low
      FROM token t
      -- The inner join on volumes reproduces the previous
      -- WHERE EXISTS (SELECT 1 FROM transactions ...) base filter: volumes
      -- groups every transaction, so its key set is exactly the tokens that
      -- have one.
      JOIN volumes v ON v.sale_address = t.sale_address
      LEFT JOIN agg_24h a24 ON a24.sale_address = t.sale_address
      LEFT JOIN agg_7d a7 ON a7.sale_address = t.sale_address
      LEFT JOIN agg_30d a30 ON a30.sale_address = t.sale_address
      LEFT JOIN agg_all aall ON aall.sale_address = t.sale_address
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
        'last_updated', past_24h_latest->>'created_at',
        'volume', volume_24h
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
        'last_updated', past_7d_latest->>'created_at',
        'volume', volume_7d
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
        'last_updated', past_30d_latest->>'created_at',
        'volume', volume_30d
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
  // Named explicitly: REFRESH MATERIALIZED VIEW CONCURRENTLY requires this
  // unique index, and the migration that (re)creates the view has to recreate
  // it under a name that does not depend on TypeORM's generated hash.
  @Index('IDX_TOKEN_PERFORMANCE_VIEW_SALE_ADDRESS', { unique: true })
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
    volume: string | null;
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
    volume: string | null;
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
    volume: string | null;
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

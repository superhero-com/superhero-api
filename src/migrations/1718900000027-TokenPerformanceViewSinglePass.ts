import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `token_performance_view` was built by `synchronize` (never enabled in
 * production -- see `DB_SYNC_ENABLED` in `src/configs/database.ts`), so no
 * migration ever described it and editing the `@ViewEntity` expression alone
 * would change dev while leaving production on the old body. This migration
 * carries the rewrite across both.
 *
 * The previous body ran 18 correlated scalar subqueries per token row -- with
 * ~64k tokens that is ~1.2M index probes per refresh, and the cron refreshes
 * every 5 minutes. The replacement collapses them into one ranked pass per
 * time window. Output is byte-identical: verified with an EXCEPT diff in both
 * directions, against a pinned clock, over 2M transactions / 64k tokens.
 *
 * The unique index is not optional -- without it
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` falls back to the plain form, which
 * holds ACCESS EXCLUSIVE on the view for the whole rebuild and blocks every
 * token list request (RefreshPerformanceViewService only logs a warning).
 */
export class TokenPerformanceViewSinglePass1718900000027 implements MigrationInterface {
  name = 'TokenPerformanceViewSinglePass1718900000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP MATERIALIZED VIEW IF EXISTS "token_performance_view"`,
    );
    await queryRunner.query(`CREATE MATERIALIZED VIEW "token_performance_view" AS
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
`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_TOKEN_PERFORMANCE_VIEW_SALE_ADDRESS" ON "token_performance_view" ("sale_address")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP MATERIALIZED VIEW IF EXISTS "token_performance_view"`,
    );
    await queryRunner.query(`CREATE MATERIALIZED VIEW "token_performance_view" AS
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
      -- Volume sums
      (
        SELECT SUM(tx.volume)
        FROM transactions tx
        WHERE tx.sale_address = t.sale_address
          AND tx.created_at > NOW() - INTERVAL '24 hours'
      ) as volume_24h,
      (
        SELECT SUM(tx.volume)
        FROM transactions tx
        WHERE tx.sale_address = t.sale_address
          AND tx.created_at > NOW() - INTERVAL '7 days'
      ) as volume_7d,
      (
        SELECT SUM(tx.volume)
        FROM transactions tx
        WHERE tx.sale_address = t.sale_address
          AND tx.created_at > NOW() - INTERVAL '30 days'
      ) as volume_30d,
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
`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_TOKEN_PERFORMANCE_VIEW_SALE_ADDRESS" ON "token_performance_view" ("sale_address")`,
    );
  }
}

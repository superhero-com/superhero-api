import { Index, ViewColumn, ViewEntity } from 'typeorm';
import { BclToken } from './bcl-token.entity';
import { BclTransaction } from './bcl-transaction.entity';

/**
 * BclTokenPerformanceView - A database view for efficient batch queries and JOINs
 *
 * This view is designed for:
 * - Fetching performance data for multiple BCL tokens at once
 * - LEFT JOIN with bcl_tokens when fetching token lists
 *
 * Usage:
 * ```typescript
 * // Get all tokens with performance
 * const tokens = await bclTokenRepo
 *   .createQueryBuilder('token')
 *   .leftJoinAndSelect('token.performance_view', 'perf_view')
 *   .getMany();
 * ```
 */
@ViewEntity({
  name: 'bcl_token_performance_view',
  // This view is refreshed periodically via `REFRESH MATERIALIZED VIEW ...`
  materialized: false,
  synchronize: true,
  // Use class references (not strings) so TypeORM can order view creation correctly.
  dependsOn: [BclToken, BclTransaction],
  expression: `
    WITH valid_transactions AS (
      -- Pre-filter and extract numeric price once to avoid repeated JSON parsing
      SELECT 
        sale_address,
        CASE
          WHEN buy_price->>'ae' IS NOT NULL AND buy_price->>'ae' != 'NaN' THEN buy_price
          WHEN previous_buy_price->>'ae' IS NOT NULL AND previous_buy_price->>'ae' != 'NaN' THEN previous_buy_price
          ELSE buy_price
        END as effective_buy_price,
        created_at,
        COALESCE(
          NULLIF(buy_price->>'ae', 'NaN')::numeric,
          NULLIF(previous_buy_price->>'ae', 'NaN')::numeric
        ) as price_numeric
      FROM bcl_transactions
      WHERE sale_address IS NOT NULL
        AND (
          (buy_price->>'ae' IS NOT NULL AND buy_price->>'ae' != 'NaN')
          OR (previous_buy_price->>'ae' IS NOT NULL AND previous_buy_price->>'ae' != 'NaN')
        )
    ),
    token_list AS (
      -- Get list of tokens that have transactions
      SELECT DISTINCT t.sale_address
      FROM bcl_tokens t
      WHERE EXISTS (
        SELECT 1 FROM valid_transactions vt WHERE vt.sale_address = t.sale_address
      )
    ),
    past_24h_latest AS (
      -- Get latest transaction in 24h window
      SELECT DISTINCT ON (vt.sale_address)
        vt.sale_address,
        vt.effective_buy_price as latest_buy_price,
        vt.created_at as latest_date
      FROM valid_transactions vt
      WHERE vt.created_at > NOW() - INTERVAL '24 hours'
        AND EXISTS (SELECT 1 FROM token_list tl WHERE tl.sale_address = vt.sale_address)
      ORDER BY vt.sale_address, vt.created_at DESC
    ),
    past_24h_agg AS (
      -- Aggregate min/max/latest for 24h window
      SELECT 
        vt.sale_address,
        MAX(vt.price_numeric) as high_price,
        MIN(vt.price_numeric) as low_price,
        MAX(vt.created_at) as latest_date
      FROM valid_transactions vt
      WHERE vt.created_at > NOW() - INTERVAL '24 hours'
        AND EXISTS (SELECT 1 FROM token_list tl WHERE tl.sale_address = vt.sale_address)
      GROUP BY vt.sale_address
    ),
    past_24h_data AS (
      SELECT 
        COALESCE(p24l.sale_address, p24a.sale_address) as sale_address,
        p24l.latest_buy_price,
        p24l.latest_date,
        p24a.high_price,
        p24a.low_price,
        p24a.latest_date as agg_latest_date
      FROM past_24h_latest p24l
      FULL OUTER JOIN past_24h_agg p24a ON p24l.sale_address = p24a.sale_address
    ),
    past_7d_latest AS (
      SELECT DISTINCT ON (vt.sale_address)
        vt.sale_address,
        vt.effective_buy_price as latest_buy_price,
        vt.created_at as latest_date
      FROM valid_transactions vt
      WHERE vt.created_at > NOW() - INTERVAL '7 days'
        AND EXISTS (SELECT 1 FROM token_list tl WHERE tl.sale_address = vt.sale_address)
      ORDER BY vt.sale_address, vt.created_at DESC
    ),
    past_7d_agg AS (
      SELECT 
        vt.sale_address,
        MAX(vt.price_numeric) as high_price,
        MIN(vt.price_numeric) as low_price,
        MAX(vt.created_at) as latest_date
      FROM valid_transactions vt
      WHERE vt.created_at > NOW() - INTERVAL '7 days'
        AND EXISTS (SELECT 1 FROM token_list tl WHERE tl.sale_address = vt.sale_address)
      GROUP BY vt.sale_address
    ),
    past_7d_data AS (
      SELECT 
        COALESCE(p7l.sale_address, p7a.sale_address) as sale_address,
        p7l.latest_buy_price,
        p7l.latest_date,
        p7a.high_price,
        p7a.low_price,
        p7a.latest_date as agg_latest_date
      FROM past_7d_latest p7l
      FULL OUTER JOIN past_7d_agg p7a ON p7l.sale_address = p7a.sale_address
    ),
    past_30d_latest AS (
      SELECT DISTINCT ON (vt.sale_address)
        vt.sale_address,
        vt.effective_buy_price as latest_buy_price,
        vt.created_at as latest_date
      FROM valid_transactions vt
      WHERE vt.created_at > NOW() - INTERVAL '30 days'
        AND EXISTS (SELECT 1 FROM token_list tl WHERE tl.sale_address = vt.sale_address)
      ORDER BY vt.sale_address, vt.created_at DESC
    ),
    past_30d_agg AS (
      SELECT 
        vt.sale_address,
        MAX(vt.price_numeric) as high_price,
        MIN(vt.price_numeric) as low_price,
        MAX(vt.created_at) as latest_date
      FROM valid_transactions vt
      WHERE vt.created_at > NOW() - INTERVAL '30 days'
        AND EXISTS (SELECT 1 FROM token_list tl WHERE tl.sale_address = vt.sale_address)
      GROUP BY vt.sale_address
    ),
    past_30d_data AS (
      SELECT 
        COALESCE(p30l.sale_address, p30a.sale_address) as sale_address,
        p30l.latest_buy_price,
        p30l.latest_date,
        p30a.high_price,
        p30a.low_price,
        p30a.latest_date as agg_latest_date
      FROM past_30d_latest p30l
      FULL OUTER JOIN past_30d_agg p30a ON p30l.sale_address = p30a.sale_address
    ),
    all_time_first AS (
      SELECT DISTINCT ON (vt.sale_address)
        vt.sale_address,
        vt.effective_buy_price as first_buy_price,
        vt.created_at as first_date
      FROM valid_transactions vt
      WHERE EXISTS (SELECT 1 FROM token_list tl WHERE tl.sale_address = vt.sale_address)
      ORDER BY vt.sale_address, vt.created_at ASC
    ),
    all_time_agg AS (
      SELECT 
        vt.sale_address,
        MAX(vt.price_numeric) as high_price,
        MIN(vt.price_numeric) as low_price
      FROM valid_transactions vt
      WHERE EXISTS (SELECT 1 FROM token_list tl WHERE tl.sale_address = vt.sale_address)
      GROUP BY vt.sale_address
    ),
    all_time_data AS (
      SELECT 
        COALESCE(atf.sale_address, ata.sale_address) as sale_address,
        atf.first_buy_price,
        atf.first_date,
        ata.high_price,
        ata.low_price
      FROM all_time_first atf
      FULL OUTER JOIN all_time_agg ata ON atf.sale_address = ata.sale_address
    ),
    aggregated_performance AS (
      -- Join all time windows together
      SELECT 
        tl.sale_address,
        p24.latest_buy_price as past_24h_buy_price,
        p24.latest_date as past_24h_latest_date,
        p24.high_price as past_24h_high_price,
        p24.low_price as past_24h_low_price,
        COALESCE(p24.agg_latest_date, p24.latest_date) as past_24h_last_updated,
        p7.latest_buy_price as past_7d_buy_price,
        p7.latest_date as past_7d_latest_date,
        p7.high_price as past_7d_high_price,
        p7.low_price as past_7d_low_price,
        COALESCE(p7.agg_latest_date, p7.latest_date) as past_7d_last_updated,
        p30.latest_buy_price as past_30d_buy_price,
        p30.latest_date as past_30d_latest_date,
        p30.high_price as past_30d_high_price,
        p30.low_price as past_30d_low_price,
        COALESCE(p30.agg_latest_date, p30.latest_date) as past_30d_last_updated,
        at.first_buy_price as all_time_first_buy_price,
        at.first_date as all_time_first_date,
        at.high_price as all_time_high_price,
        at.low_price as all_time_low_price
      FROM token_list tl
      LEFT JOIN past_24h_data p24 ON tl.sale_address = p24.sale_address
      LEFT JOIN past_7d_data p7 ON tl.sale_address = p7.sale_address
      LEFT JOIN past_30d_data p30 ON tl.sale_address = p30.sale_address
      LEFT JOIN all_time_data at ON tl.sale_address = at.sale_address
    )
    SELECT
      sale_address,
      -- Past 24h object
      json_build_object(
        'current', past_24h_buy_price,
        'current_date', past_24h_latest_date,
        'current_change', 
          CASE 
            WHEN past_24h_high_price IS NOT NULL AND past_24h_low_price IS NOT NULL 
            THEN past_24h_high_price - past_24h_low_price
            ELSE NULL
          END,
        'current_change_percent',
          CASE 
            WHEN past_24h_high_price IS NOT NULL AND past_24h_low_price IS NOT NULL 
              AND past_24h_low_price != 0
            THEN ((past_24h_high_price - past_24h_low_price) / past_24h_low_price) * 100
            ELSE NULL
          END,
        'current_change_direction',
          CASE 
            WHEN past_24h_high_price IS NOT NULL AND past_24h_low_price IS NOT NULL 
            THEN 
              CASE 
                WHEN past_24h_high_price > past_24h_low_price THEN 'up'
                WHEN past_24h_high_price < past_24h_low_price THEN 'down'
                ELSE 'neutral'
              END
            ELSE NULL
          END,
        'high', json_build_object('ae', past_24h_high_price::text),
        'high_date', past_24h_last_updated,
        'low', json_build_object('ae', past_24h_low_price::text),
        'low_date', past_24h_last_updated,
        'last_updated', past_24h_last_updated
      ) as past_24h,
      -- Past 7d object
      json_build_object(
        'current', past_7d_buy_price,
        'current_date', past_7d_latest_date,
        'current_change',
          CASE 
            WHEN past_7d_high_price IS NOT NULL AND past_7d_low_price IS NOT NULL 
            THEN past_7d_high_price - past_7d_low_price
            ELSE NULL
          END,
        'current_change_percent',
          CASE 
            WHEN past_7d_high_price IS NOT NULL AND past_7d_low_price IS NOT NULL 
              AND past_7d_low_price != 0
            THEN ((past_7d_high_price - past_7d_low_price) / past_7d_low_price) * 100
            ELSE NULL
          END,
        'current_change_direction',
          CASE 
            WHEN past_7d_high_price IS NOT NULL AND past_7d_low_price IS NOT NULL 
            THEN 
              CASE 
                WHEN past_7d_high_price > past_7d_low_price THEN 'up'
                WHEN past_7d_high_price < past_7d_low_price THEN 'down'
                ELSE 'neutral'
              END
            ELSE NULL
          END,
        'high', json_build_object('ae', past_7d_high_price::text),
        'high_date', past_7d_last_updated,
        'low', json_build_object('ae', past_7d_low_price::text),
        'low_date', past_7d_last_updated,
        'last_updated', past_7d_last_updated
      ) as past_7d,
      -- Past 30d object
      json_build_object(
        'current', past_30d_buy_price,
        'current_date', past_30d_latest_date,
        'current_change',
          CASE 
            WHEN past_30d_high_price IS NOT NULL AND past_30d_low_price IS NOT NULL 
            THEN past_30d_high_price - past_30d_low_price
            ELSE NULL
          END,
        'current_change_percent',
          CASE 
            WHEN past_30d_high_price IS NOT NULL AND past_30d_low_price IS NOT NULL 
              AND past_30d_low_price != 0
            THEN ((past_30d_high_price - past_30d_low_price) / past_30d_low_price) * 100
            ELSE NULL
          END,
        'current_change_direction',
          CASE 
            WHEN past_30d_high_price IS NOT NULL AND past_30d_low_price IS NOT NULL 
            THEN 
              CASE 
                WHEN past_30d_high_price > past_30d_low_price THEN 'up'
                WHEN past_30d_high_price < past_30d_low_price THEN 'down'
                ELSE 'neutral'
              END
            ELSE NULL
          END,
        'high', json_build_object('ae', past_30d_high_price::text),
        'high_date', past_30d_last_updated,
        'low', json_build_object('ae', past_30d_low_price::text),
        'low_date', past_30d_last_updated,
        'last_updated', past_30d_last_updated
      ) as past_30d,
      -- All time object
      json_build_object(
        'current', all_time_first_buy_price,
        'current_date', all_time_first_date,
        'high', json_build_object('ae', all_time_high_price::text),
        'high_date', all_time_first_date,
        'low', json_build_object('ae', all_time_low_price::text),
        'low_date', all_time_first_date
      ) as all_time
    FROM aggregated_performance
  `,
})
export class BclTokenPerformanceView {
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

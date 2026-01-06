import { ViewColumn, ViewEntity, PrimaryColumn, Index } from 'typeorm';
import { BclToken } from './bcl-token.entity';
import { BclTransaction } from './bcl-transaction.entity';

@ViewEntity({
  name: 'bcl_token_stats',
  // This view is refreshed periodically via `REFRESH MATERIALIZED VIEW ...`
  materialized: false,
  synchronize: true,
  // Use class references (not strings) so TypeORM can order view creation correctly.
  dependsOn: [BclToken, BclTransaction],
  expression: `
    WITH time_window AS (
      SELECT NOW() - INTERVAL '24 hours' as start_time
    ),
    token_transactions_24h AS (
      SELECT 
        bt.sale_address,
        COUNT(DISTINCT bt.caller_id) as unique_transactions,
        COALESCE(SUM(
          CASE 
            WHEN bt.tx_type IN ('buy', 'create_community') 
            THEN CAST(NULLIF(bt.amount->>'ae', 'NaN') AS DECIMAL)
            ELSE 0
          END
        ), 0) as investment_volume
      FROM bcl_transactions bt
      CROSS JOIN time_window tw
      WHERE bt.created_at >= tw.start_time
        AND bt.sale_address IS NOT NULL
        AND bt.caller_id IS NOT NULL
      GROUP BY bt.sale_address
    ),
    token_metrics AS (
      SELECT 
        t.sale_address,
        COALESCE(tt.unique_transactions, 0) as unique_transactions,
        COALESCE(tt.investment_volume, 0) as investment_volume,
        GREATEST(1, LEAST(
          EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60,
          1440
        ))::int as lifetime_minutes,
        MIN(COALESCE(tt.unique_transactions, 0)) OVER () as min_unique_transactions,
        MAX(COALESCE(tt.unique_transactions, 0)) OVER () as max_unique_transactions,
        MIN(COALESCE(tt.investment_volume, 0)) OVER () as min_investment_volume,
        MAX(COALESCE(tt.investment_volume, 0)) OVER () as max_investment_volume
      FROM bcl_tokens t
      LEFT JOIN token_transactions_24h tt ON t.sale_address = tt.sale_address
      WHERE t.unlisted = false
    ),
    normalized_metrics AS (
      SELECT 
        sale_address,
        unique_transactions,
        investment_volume,
        lifetime_minutes,
        min_unique_transactions,
        max_unique_transactions,
        min_investment_volume,
        max_investment_volume,
        CASE 
          WHEN max_unique_transactions - min_unique_transactions > 0
          THEN (unique_transactions - min_unique_transactions)::numeric / 
               (max_unique_transactions - min_unique_transactions)::numeric
          ELSE 0
        END as tx_normalization,
        CASE 
          WHEN max_investment_volume - min_investment_volume > 0
          THEN (investment_volume - min_investment_volume)::numeric / 
               (max_investment_volume - min_investment_volume)::numeric
          ELSE 0
        END as volume_normalization
      FROM token_metrics
    )
    SELECT 
      sale_address,
      unique_transactions,
      investment_volume,
      lifetime_minutes,
      min_unique_transactions,
      max_unique_transactions,
      min_investment_volume,
      max_investment_volume,
      tx_normalization,
      volume_normalization,
      GREATEST(
        0.6 * tx_normalization + 
        0.4 * (volume_normalization / GREATEST(lifetime_minutes, 1)),
        0
      ) as trending_score,
      NOW() as calculated_at
    FROM normalized_metrics
  `,
})
export class BclTokenStats {
  @PrimaryColumn()
  @ViewColumn()
  @Index({ unique: true })
  sale_address: string;

  @ViewColumn()
  unique_transactions: number;

  @ViewColumn()
  investment_volume: number;

  @ViewColumn()
  lifetime_minutes: number;

  @ViewColumn()
  min_unique_transactions: number;

  @ViewColumn()
  max_unique_transactions: number;

  @ViewColumn()
  min_investment_volume: number;

  @ViewColumn()
  max_investment_volume: number;

  @ViewColumn()
  tx_normalization: number;

  @ViewColumn()
  volume_normalization: number;

  @ViewColumn()
  @Index()
  trending_score: number;

  @ViewColumn()
  calculated_at: Date;
}


import { ViewColumn, ViewEntity, PrimaryColumn, Index } from 'typeorm';
import { BCL_CONTRACT } from '../config/bcl.config';

@ViewEntity({
  name: 'bcl_token_view',
  materialized: true,
  synchronize: true,
  expression: `
    WITH token_metadata AS (
      SELECT 
        data->'bcl'->'data'->>'sale_address' as sale_address,
        data->'bcl'->'data'->>'address' as address,
        data->'bcl'->'data'->>'factory_address' as factory_address,
        data->'bcl'->'data'->>'dao_address' as dao_address,
        data->'bcl'->'data'->>'creator_address' as creator_address,
        data->'bcl'->'data'->>'beneficiary_address' as beneficiary_address,
        data->'bcl'->'data'->>'bonding_curve_address' as bonding_curve_address,
        data->'bcl'->'data'->>'owner_address' as owner_address,
        data->'bcl'->'data'->>'name' as name,
        data->'bcl'->'data'->>'symbol' as symbol,
        (data->'bcl'->'data'->>'decimals')::int as decimals,
        data->'bcl'->'data'->>'collection' as collection,
        data->'bcl'->'data'->'dao_balance' as dao_balance,
        hash as create_tx_hash,
        to_timestamp(micro_time::bigint / 1000) as created_at
      FROM txs
      WHERE function = 'create_community'
        AND data->'bcl' IS NOT NULL
        AND data->'bcl'->'data' IS NOT NULL
        AND data->'bcl'->'data'->>'factory_address' = '${BCL_CONTRACT.contractAddress}'
        AND data->'bcl'->'data'->>'sale_address' IS NOT NULL
    ),
    latest_transactions AS (
      SELECT DISTINCT ON (sale_address)
        sale_address,
        hash as last_tx_hash,
        block_height as last_sync_block_height,
        buy_price,
        sell_price,
        market_cap,
        total_supply
      FROM bcl_transactions_view
      WHERE sale_address IS NOT NULL
        AND buy_price IS NOT NULL
      ORDER BY sale_address, created_at DESC, block_height DESC
    ),
    transaction_counts AS (
      SELECT 
        sale_address,
        COUNT(*) as tx_count
      FROM bcl_transactions_view
      WHERE sale_address IS NOT NULL
      GROUP BY sale_address
    ),
    -- holder_counts AS (
    --   SELECT 
    --     aex9_address,
    --     COUNT(*) as holders_count
    --   FROM token_holders
    --   GROUP BY aex9_address
    -- ),
    ranked_tokens AS (
      SELECT 
        tm.*,
        lt.last_tx_hash,
        lt.last_sync_block_height,
        lt.buy_price,
        lt.sell_price,
        lt.market_cap,
        lt.total_supply,
        COALESCE(tc.tx_count, 0) as tx_count,
        0 as holders_count,
        CAST(RANK() OVER (
          ORDER BY 
            CASE WHEN lt.market_cap IS NULL OR (lt.market_cap->>'ae')::numeric = 0 THEN 1 ELSE 0 END,
            (lt.market_cap->>'ae')::numeric DESC NULLS LAST,
            tm.created_at ASC
        ) AS INTEGER) as rank
      FROM token_metadata tm
      LEFT JOIN latest_transactions lt ON tm.sale_address = lt.sale_address
      LEFT JOIN transaction_counts tc ON tm.sale_address = tc.sale_address
      -- LEFT JOIN holder_counts hc ON tm.address = hc.aex9_address
    )
    SELECT 
      sale_address,
      false as unlisted,
      0 as last_sync_tx_count,
      tx_count,
      holders_count,
      factory_address,
      create_tx_hash,
      dao_address,
      creator_address,
      beneficiary_address,
      bonding_curve_address,
      COALESCE((dao_balance->>'ae')::numeric, 0) as dao_balance,
      owner_address,
      address,
      name,
      symbol,
      decimals,
      collection,
      COALESCE((buy_price->>'ae')::numeric, 0) as price,
      buy_price as price_data,
      COALESCE((sell_price->>'ae')::numeric, 0) as sell_price,
      sell_price as sell_price_data,
      COALESCE((market_cap->>'ae')::numeric, 0) as market_cap,
      market_cap as market_cap_data,
      total_supply,
      0.0 as trending_score,
      NULL::timestamp as trending_score_update_at,
      created_at,
      last_tx_hash,
      last_sync_block_height,
      rank
    FROM ranked_tokens
  `,
})
export class BclToken {
  @PrimaryColumn()
  @ViewColumn()
  @Index({ unique: true })
  sale_address: string;

  @ViewColumn()
  unlisted: boolean;

  @ViewColumn()
  last_sync_tx_count: number;

  @ViewColumn()
  tx_count: number;

  @ViewColumn()
  holders_count: number;

  @ViewColumn()
  @Index()
  factory_address: string;

  @ViewColumn()
  create_tx_hash: string;

  @ViewColumn()
  dao_address: string;

  @ViewColumn()
  @Index()
  creator_address: string;

  @ViewColumn()
  beneficiary_address: string;

  @ViewColumn()
  bonding_curve_address: string;

  @ViewColumn()
  dao_balance: number;

  @ViewColumn()
  @Index()
  owner_address: string;

  @ViewColumn()
  @Index()
  address: string;

  @ViewColumn()
  @Index()
  name: string;

  @ViewColumn()
  @Index()
  symbol: string;

  @ViewColumn()
  decimals: number;

  @ViewColumn()
  collection: string;

  @ViewColumn()
  price: number;

  @ViewColumn()
  price_data: any;

  @ViewColumn()
  sell_price: number;

  @ViewColumn()
  sell_price_data: any;

  @ViewColumn()
  market_cap: number;

  @ViewColumn()
  market_cap_data: any;

  @ViewColumn()
  total_supply: string;

  @ViewColumn()
  trending_score: number;

  @ViewColumn()
  trending_score_update_at: Date;

  @ViewColumn()
  created_at: Date;

  @ViewColumn()
  last_tx_hash: string;

  @ViewColumn()
  last_sync_block_height: number;

  @ViewColumn()
  @Index()
  rank: number;
}


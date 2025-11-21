import { ViewColumn, ViewEntity, PrimaryColumn, Index } from 'typeorm';

@ViewEntity({
  name: 'bcl_tokens_view',
  materialized: false,
  synchronize: true,
  expression: `
    WITH latest_transactions AS (
      SELECT DISTINCT ON (sale_address)
        sale_address,
        hash as last_tx_hash,
        block_height as last_sync_block_height,
        buy_price,
        sell_price,
        market_cap,
        total_supply
      FROM bcl_transactions
      WHERE sale_address IS NOT NULL
        AND buy_price IS NOT NULL
      ORDER BY sale_address, created_at DESC, block_height DESC
    ),
    transaction_counts AS (
      SELECT 
        sale_address,
        COUNT(*)::int as tx_count
      FROM bcl_transactions
      WHERE sale_address IS NOT NULL
      GROUP BY sale_address
    ),
    tokens_with_transactions AS (
      SELECT 
        bt.sale_address,
        bt.unlisted,
        bt.factory_address,
        bt.create_tx_hash,
        bt.dao_address,
        bt.creator_address,
        bt.beneficiary_address,
        bt.bonding_curve_address,
        bt.dao_balance,
        bt.owner_address,
        bt.address,
        bt.name,
        bt.symbol,
        bt.decimals,
        bt.collection,
        COALESCE(ts.trending_score, 0) as trending_score,
        ts.calculated_at as trending_score_update_at,
        bt.created_at,
        lt.last_tx_hash,
        lt.last_sync_block_height,
        lt.buy_price,
        lt.sell_price,
        lt.market_cap,
        lt.total_supply,
        COALESCE(tc.tx_count, 0) as tx_count
      FROM bcl_tokens bt
      LEFT JOIN latest_transactions lt ON bt.sale_address = lt.sale_address
      LEFT JOIN transaction_counts tc ON bt.sale_address = tc.sale_address
      LEFT JOIN bcl_token_stats ts ON bt.sale_address = ts.sale_address
    )
    SELECT 
      sale_address,
      unlisted,
      factory_address,
      create_tx_hash,
      dao_address,
      creator_address,
      beneficiary_address,
      bonding_curve_address,
      dao_balance,
      owner_address,
      address,
      name,
      symbol,
      decimals,
      collection,
      trending_score,
      trending_score_update_at,
      created_at,
      last_tx_hash,
      last_sync_block_height,
      buy_price,
      sell_price,
      market_cap,
      total_supply,
      tx_count,
      CAST(RANK() OVER (
        ORDER BY 
          CASE WHEN market_cap IS NULL OR (market_cap->>'ae')::numeric = 0 THEN 1 ELSE 0 END,
          (market_cap->>'ae')::numeric DESC NULLS LAST,
          created_at ASC
      ) AS INTEGER) as rank
    FROM tokens_with_transactions
  `,
})
export class BclTokenView {
  @PrimaryColumn()
  @ViewColumn()
  @Index({ unique: true })
  sale_address: string;

  @ViewColumn()
  unlisted: boolean;

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
  dao_balance: any;

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
  buy_price: any;

  @ViewColumn()
  sell_price: any;

  @ViewColumn()
  market_cap: any;

  @ViewColumn()
  total_supply: string;

  @ViewColumn()
  tx_count: number;

  @ViewColumn()
  @Index()
  rank: number;
}


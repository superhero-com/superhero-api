import { ViewColumn, ViewEntity, PrimaryColumn, Index } from 'typeorm';
import { BCL_CONTRACT } from '../config/bcl.config';

@ViewEntity({
  name: 'bcl_transactions_view',
  materialized: true,
  synchronize: true,
  expression: `
    SELECT 
      hash,
      block_hash,
      block_height,
      caller_id,
      function,
      created_at,
      data->'bcl'->'data'->'amount' as amount,
      data->'bcl'->'data'->>'volume' as volume,
      data->'bcl'->'data'->>'tx_type' as tx_type,
      data->'bcl'->'data'->'buy_price' as buy_price,
      data->'bcl'->'data'->'sell_price' as sell_price,
      data->'bcl'->'data'->'market_cap' as market_cap,
      data->'bcl'->'data'->'unit_price' as unit_price,
      data->'bcl'->'data'->'previous_buy_price' as previous_buy_price,
      data->'bcl'->'data'->>'sale_address' as sale_address,
      data->'bcl'->'data'->>'total_supply' as total_supply,
      data->'bcl'->'data'->>'protocol_reward' as protocol_reward,
      (data->'bcl'->>'_version')::int as _version,
      (EXTRACT(EPOCH FROM (NOW() - to_timestamp(micro_time::bigint / 1000))) / 3600 >= 5) as verified
    FROM txs
    WHERE function IN ('buy', 'sell', 'create_community')
      AND data->'bcl' IS NOT NULL
      AND data->'bcl'->'data' IS NOT NULL
      AND (
        -- For create_community: only include if factory_address matches BCL contract
        (function = 'create_community' AND data->'bcl'->'data'->>'factory_address' = '${BCL_CONTRACT.contractAddress}')
        OR
        -- For buy/sell: only include if sale_address exists in create_community transactions from BCL factory
        (function IN ('buy', 'sell') AND data->'bcl'->'data'->>'sale_address' IN (
          SELECT data->'bcl'->'data'->>'sale_address'
          FROM txs
          WHERE function = 'create_community'
            AND data->'bcl' IS NOT NULL
            AND data->'bcl'->'data' IS NOT NULL
            AND data->'bcl'->'data'->>'factory_address' = '${BCL_CONTRACT.contractAddress}'
            AND data->'bcl'->'data'->>'sale_address' IS NOT NULL
        ))
      )
  `,
})
export class BclTransaction {
  @PrimaryColumn()
  @ViewColumn()
  @Index({ unique: true })
  hash: string;

  @ViewColumn()
  @Index()
  block_hash: string;

  @ViewColumn()
  block_height: number;

  @ViewColumn()
  @Index()
  caller_id?: string;

  @ViewColumn()
  @Index()
  function: string;

  @ViewColumn()
  created_at: Date;

  @ViewColumn()
  amount: any;

  @ViewColumn()
  volume?: string;

  @ViewColumn()
  tx_type?: string;

  @ViewColumn()
  buy_price: any;

  @ViewColumn()
  sell_price?: any;

  @ViewColumn()
  market_cap?: any;

  @ViewColumn()
  unit_price?: any;

  @ViewColumn()
  previous_buy_price?: any;

  @ViewColumn()
  sale_address?: string;

  @ViewColumn()
  total_supply?: string;

  @ViewColumn()
  protocol_reward?: string;

  @ViewColumn()
  _version: number;

  @ViewColumn()
  verified: boolean;
}


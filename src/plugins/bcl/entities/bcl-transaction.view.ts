import { ViewColumn, ViewEntity, PrimaryColumn } from 'typeorm';

@ViewEntity({
  name: 'bcl_transaction_view',
  materialized: false,
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
    WHERE function IN ('buy', 'sell')
      AND data->'bcl' IS NOT NULL
      AND data->'bcl'->'data' IS NOT NULL
  `,
})
export class BclTransaction {
  @PrimaryColumn()
  @ViewColumn()
  hash: string;

  @ViewColumn()
  block_hash: string;

  @ViewColumn()
  block_height: number;

  @ViewColumn()
  caller_id?: string;

  @ViewColumn()
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


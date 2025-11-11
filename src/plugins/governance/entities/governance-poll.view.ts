import { ViewColumn, ViewEntity, PrimaryColumn } from 'typeorm';

@ViewEntity({
  name: 'governance_poll_view',
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
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'author' as author,
      data->'governance'->'data'->'metadata' as metadata,
      data->'governance'->'data'->>'poll_seq_id' as poll_seq_id,
      (data->'governance'->'data'->>'close_height')::int as close_height,
      data->'governance'->'data'->>'poll_address' as poll_address,
      data->'governance'->'data'->'vote_options' as vote_options,
      (data->'governance'->'data'->>'create_height')::int as create_height,
      (data->'governance'->'data'->>'close_at_height')::int as close_at_height,
      (
        SELECT COUNT(*)
        FROM txs v
        WHERE v.function IN ('vote', 'revoke_vote')
          AND v.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
          AND v.data->'governance' IS NOT NULL
      )::int as votes_count,
      (
        SELECT COALESCE(jsonb_object_agg(option_key::text, vote_count), '{}'::jsonb)
        FROM (
          SELECT 
            (v.data->'governance'->'data'->>'option')::int as option_key,
            COUNT(*)::int as vote_count
          FROM txs v
          WHERE v.function = 'vote'
            AND v.data->'governance'->'data'->>'poll_address' = txs.data->'governance'->'data'->>'poll_address'
            AND v.data->'governance'->'data'->>'option' IS NOT NULL
            AND v.data->'governance' IS NOT NULL
          GROUP BY (v.data->'governance'->'data'->>'option')::int
        ) option_counts
      ) as votes_count_by_option
    FROM txs
    WHERE contract_id = 'ct_ouZib4wT9cNwgRA1pxgA63XEUd8eQRrG8PcePDEYogBc1VYTq'
      AND function = 'add_poll'
      AND data->'governance' IS NOT NULL
  `,
})
export class GovernancePoll {
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
  _version: number;

  @ViewColumn()
  author?: string;

  @ViewColumn()
  metadata?: {
    link: string;
    title: string;
    spec_ref: number[];
    description: string;
  };

  @ViewColumn()
  poll_seq_id?: string;

  @ViewColumn()
  close_height?: number;

  @ViewColumn()
  poll_address?: string;

  @ViewColumn()
  vote_options?: Array<{
    key: number;
    val: string;
  }>;

  @ViewColumn()
  create_height?: number;

  @ViewColumn()
  close_at_height?: number;

  @ViewColumn()
  votes_count: number;

  @ViewColumn()
  votes_count_by_option?: Record<string, number>;
}


import { ViewColumn, ViewEntity, PrimaryColumn } from 'typeorm';

@ViewEntity({
  name: 'governance_poll_vote_view',
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
      data->'governance'->'data' as data,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'poll_address' as poll_address
    FROM txs
    WHERE function IN ('vote', 'revoke_vote')
      AND data->'governance'->'data'->>'poll_address' IS NOT NULL
      AND data->'governance' IS NOT NULL
  `,
})
export class GovernancePollVote {
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
  data: any;

  @ViewColumn()
  _version: number;

  @ViewColumn()
  poll_address?: string;
}

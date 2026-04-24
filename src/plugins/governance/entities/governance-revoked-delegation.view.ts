import { ViewColumn, ViewEntity, PrimaryColumn } from 'typeorm';

// NOTE: no contract_id filter. The ingest filter
// (GovernancePlugin.filters()) only persists revoke_delegation rows that
// target the configured governance registry contract, so the
// `data->'governance' IS NOT NULL` guard is sufficient and lets this view
// work identically on mainnet, testnet, and any custom registry deployment.
@ViewEntity({
  name: 'governance_revoked_delegation_view',
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
      micro_time,
      data->'governance'->'data' as data,
      (data->'governance'->>'_version')::int as _version,
      data->'governance'->'data'->>'delegator' as delegator
    FROM txs
    WHERE function = 'revoke_delegation'
      AND data->'governance'->'data'->>'delegator' IS NOT NULL
      AND data->'governance' IS NOT NULL
  `,
})
export class GovernanceRevokedDelegation {
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
  micro_time: string;

  @ViewColumn()
  data: any;

  @ViewColumn()
  _version: number;

  @ViewColumn()
  delegator?: string;
}

import { ViewColumn, ViewEntity, PrimaryColumn } from 'typeorm';
import { GOVERNANCE_CONTRACT } from '../config/governance.config';

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
    WHERE contract_id = '${GOVERNANCE_CONTRACT.contractAddress}'
      AND function = 'revoke_delegation'
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


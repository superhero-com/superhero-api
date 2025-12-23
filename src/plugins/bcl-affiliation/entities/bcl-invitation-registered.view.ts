import { PrimaryColumn, ViewColumn, ViewEntity, Index } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { BCL_AFFILIATION_CONTRACT } from '../config/bcl-affiliation.config';

@ViewEntity({
  name: 'bcl_invitation_registered_view',
  materialized: false,
  synchronize: true,
  expression: `
    SELECT
      (hash || ':' || invitation_ordinality)::text as id,
      hash,
      block_hash,
      block_height,
      micro_time,
      caller_id,
      contract_id,
      function,
      created_at,
      (data->'bcl-affiliation'->>'_version')::int as _version,
      data->'bcl-affiliation'->'data'->>'event_name' as event_name,
      data->'bcl-affiliation'->'data'->>'contract' as contract,
      invitation_ordinality::int as invitation_index,
      invitation->>'inviter' as inviter,
      invitation->>'invitee' as invitee,
      invitation->>'amount' as amount
    FROM txs
    CROSS JOIN LATERAL jsonb_array_elements(
      data->'bcl-affiliation'->'data'->'invitations'
    ) WITH ORDINALITY as invitation(invitation, invitation_ordinality)
    WHERE contract_id = '${BCL_AFFILIATION_CONTRACT.contractAddress}'
      AND function = '${BCL_AFFILIATION_CONTRACT.FUNCTIONS.register_invitation_code}'
      AND data->'bcl-affiliation' IS NOT NULL
      AND jsonb_typeof(data->'bcl-affiliation'->'data'->'invitations') = 'array'
      AND data->'bcl-affiliation'->'data'->>'event_name' = 'InvitationRegistered'
  `,
})
export class BclInvitationRegistered {
  @PrimaryColumn()
  @ViewColumn()
  @ApiProperty({ description: 'Unique row id (tx hash + invitation index)' })
  id: string;

  @ViewColumn()
  @Index()
  @ApiProperty({ description: 'Transaction hash' })
  hash: string;

  @ViewColumn()
  @ApiProperty({ description: 'Block hash' })
  block_hash: string;

  @ViewColumn()
  @ApiProperty({ description: 'Block height' })
  block_height: number;

  @ViewColumn()
  @ApiProperty({ description: 'Micro time' })
  micro_time: string;

  @ViewColumn()
  @ApiProperty({ description: 'Caller ID', required: false, nullable: true })
  caller_id?: string;

  @ViewColumn()
  @ApiProperty({ description: 'Contract ID from tx', required: false, nullable: true })
  contract_id?: string;

  @ViewColumn()
  @ApiProperty({ description: 'Function name from tx', required: false, nullable: true })
  function?: string;

  @ViewColumn()
  @ApiProperty({ description: 'Created at timestamp' })
  created_at: Date;

  @ViewColumn()
  @ApiProperty({ description: 'Plugin version' })
  _version: number;

  @ViewColumn()
  @ApiProperty({
    description: 'Event name (InvitationRegistered)',
    required: false,
    nullable: true,
  })
  event_name?: string;

  @ViewColumn()
  @Index()
  @ApiProperty({ description: 'Affiliation contract address', required: false, nullable: true })
  contract?: string;

  @ViewColumn()
  @ApiProperty({ description: '0-based invitation index within the tx invitations array' })
  invitation_index: number;

  @ViewColumn()
  @Index()
  @ApiProperty({ description: 'Inviter address', required: false, nullable: true })
  inviter?: string;

  @ViewColumn()
  @Index()
  @ApiProperty({ description: 'Invitee address', required: false, nullable: true })
  invitee?: string;

  @ViewColumn()
  @ApiProperty({ description: 'Invitation amount (AE)', required: false, nullable: true })
  amount?: string;
}



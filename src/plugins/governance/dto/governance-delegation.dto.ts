import { ApiProperty } from '@nestjs/swagger';

export class GovernanceDelegationDto {
  @ApiProperty({ description: 'Transaction hash' })
  hash: string;

  @ApiProperty({ description: 'Block hash' })
  block_hash: string;

  @ApiProperty({ description: 'Block height' })
  block_height: number;

  @ApiProperty({ description: 'Caller ID', nullable: true })
  caller_id?: string;

  @ApiProperty({ description: 'Function name' })
  function: string;

  @ApiProperty({ description: 'Created at timestamp' })
  created_at: Date;

  @ApiProperty({ description: 'Micro time' })
  micro_time: string;

  @ApiProperty({ description: 'Governance decoded data' })
  data: any;

  @ApiProperty({ description: 'Plugin version' })
  _version: number;

  @ApiProperty({ description: 'Delegator address' })
  delegator?: string;

  @ApiProperty({ description: 'Delegatee address' })
  delegatee?: string;
}

export class GovernanceRevokedDelegationDto {
  @ApiProperty({ description: 'Transaction hash' })
  hash: string;

  @ApiProperty({ description: 'Block hash' })
  block_hash: string;

  @ApiProperty({ description: 'Block height' })
  block_height: number;

  @ApiProperty({ description: 'Caller ID', nullable: true })
  caller_id?: string;

  @ApiProperty({ description: 'Function name' })
  function: string;

  @ApiProperty({ description: 'Created at timestamp' })
  created_at: Date;

  @ApiProperty({ description: 'Micro time' })
  micro_time: string;

  @ApiProperty({ description: 'Governance decoded data' })
  data: any;

  @ApiProperty({ description: 'Plugin version' })
  _version: number;

  @ApiProperty({ description: 'Delegator address' })
  delegator?: string;
}

export class GovernanceDelegationWithRevokedDto extends GovernanceDelegationDto {
  @ApiProperty({ description: 'Whether this delegation has been revoked' })
  revoked: boolean;

  @ApiProperty({
    description: 'Revocation transaction hash if revoked',
    nullable: true,
  })
  revoked_hash?: string;

  @ApiProperty({
    description: 'Revocation block height if revoked',
    nullable: true,
  })
  revoked_block_height?: number;

  @ApiProperty({
    description: 'Revocation timestamp if revoked',
    nullable: true,
  })
  revoked_at?: Date;
}

export class GovernanceDelegationHistoryItemDto {
  @ApiProperty({ description: 'Transaction hash' })
  hash: string;

  @ApiProperty({ description: 'Block hash' })
  block_hash: string;

  @ApiProperty({ description: 'Block height' })
  block_height: number;

  @ApiProperty({ description: 'Caller ID', nullable: true })
  caller_id?: string;

  @ApiProperty({ description: 'Function name' })
  function: string;

  @ApiProperty({ description: 'Created at timestamp' })
  created_at: Date;

  @ApiProperty({ description: 'Micro time' })
  micro_time: string;

  @ApiProperty({ description: 'Governance decoded data' })
  data: any;

  @ApiProperty({ description: 'Plugin version' })
  _version: number;

  @ApiProperty({ description: 'Delegator address', nullable: true })
  delegator?: string;

  @ApiProperty({ description: 'Delegatee address', nullable: true })
  delegatee?: string;
}

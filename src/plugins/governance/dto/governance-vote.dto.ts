import { ApiProperty } from '@nestjs/swagger';

export class GovernancePollDto {
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

  @ApiProperty({ description: 'Plugin version' })
  _version: number;

  @ApiProperty({ description: 'Poll author address', nullable: true })
  author?: string;

  @ApiProperty({
    description: 'Poll metadata',
    nullable: true,
    type: 'object',
    properties: {
      link: { type: 'string' },
      title: { type: 'string' },
      spec_ref: { type: 'array', items: { type: 'number' } },
      description: { type: 'string' },
    },
  })
  metadata?: {
    link: string;
    title: string;
    spec_ref: number[];
    description: string;
  };

  @ApiProperty({ description: 'Poll sequence ID', nullable: true })
  poll_seq_id?: string;

  @ApiProperty({ description: 'Close height', nullable: true })
  close_height?: number;

  @ApiProperty({ description: 'Poll address' })
  poll_address?: string;

  @ApiProperty({
    description: 'Vote options',
    nullable: true,
    type: 'array',
    items: {
      type: 'object',
      properties: {
        key: { type: 'number' },
        val: { type: 'string' },
      },
    },
  })
  vote_options?: Array<{
    key: number;
    val: string;
  }>;

  @ApiProperty({ description: 'Create height', nullable: true })
  create_height?: number;

  @ApiProperty({ description: 'Close at height', nullable: true })
  close_at_height?: number;

  @ApiProperty({ description: 'Total number of votes (including vote and revoke_vote transactions)' })
  votes_count: number;

  @ApiProperty({
    description: 'Vote counts per option (maps option key to vote count)',
    nullable: true,
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { '0': 5, '1': 3, '2': 1, '3': 0 },
  })
  votes_count_by_option?: Record<string, number>;
}

export class GovernancePollVoteDto {
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

  @ApiProperty({ description: 'Governance decoded data' })
  data: any;

  @ApiProperty({ description: 'Plugin version' })
  _version: number;

  @ApiProperty({ description: 'Poll address' })
  poll_address?: string;
}

export class GovernanceVoteDto {
  @ApiProperty({ description: 'Poll transaction (add_poll)' })
  poll: GovernancePollDto;

  @ApiProperty({ description: 'Vote transactions (vote or revoke_vote)', type: [GovernancePollVoteDto] })
  votes: GovernancePollVoteDto[];
}


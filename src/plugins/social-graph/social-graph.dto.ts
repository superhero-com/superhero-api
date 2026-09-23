import { ApiProperty } from '@nestjs/swagger';
import {
  SocialGraphAccountDto,
  SocialGraphRelationshipDto,
} from './dto/social-graph.dto';

const decimal = {
  type: String,
  pattern: '^(0|[1-9][0-9]*)$',
  description: 'Exact nonnegative chain integer as a decimal string.',
};
export class GraphIdentityDto {
  @ApiProperty() network: string;
  @ApiProperty() contract: string;
}
export class GraphSnapshotDto extends GraphIdentityDto {
  @ApiProperty() block_hash: string;
  @ApiProperty(decimal) height: string;
}
export class GraphConfigDto {
  @ApiProperty(decimal) max_following: string;
  @ApiProperty(decimal) max_blocked: string;
  @ApiProperty(decimal) follow_cooldown: string;
  @ApiProperty(decimal) minimum_balance: string;
  @ApiProperty(decimal) cleanup_grace: string;
}
export class GraphPendingPolicyDto {
  @ApiProperty({ type: GraphConfigDto }) config: GraphConfigDto;
  @ApiProperty(decimal) activation_height: string;
}
export class GraphPolicyDto extends GraphSnapshotDto {
  @ApiProperty({ enum: [2] }) version: number;
  @ApiProperty({ type: GraphConfigDto }) config: GraphConfigDto;
  @ApiProperty(decimal) config_version: string;
  @ApiProperty({ type: GraphPendingPolicyDto, nullable: true })
  pending_config: GraphPendingPolicyDto | null;
  @ApiProperty() owner: string;
  @ApiProperty({ type: String, nullable: true }) pending_owner: string | null;
  @ApiProperty({ type: String, nullable: true }) successor: string | null;
  @ApiProperty(decimal) freeze_height: string;
  @ApiProperty() frozen: boolean;
  @ApiProperty() importing: boolean;
  @ApiProperty({ type: String, nullable: true }) import_source: string | null;
  @ApiProperty({ type: String, nullable: true }) legacy_source: string | null;
  @ApiProperty() source_sha256: string;
}
export class GraphProjectionDto extends GraphIdentityDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Height of the last fully indexed key-block state.',
  })
  completed_height: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Height containing the last atomically indexed transaction, if catching up.',
  })
  pending_height: string | null;
  @ApiProperty({ type: String, nullable: true }) pending_position:
    string | null;
  @ApiProperty() catching_up: boolean;
}
export class GraphCountsDto extends GraphProjectionDto {
  @ApiProperty(decimal) generation: string;
  @ApiProperty() address: string;
  @ApiProperty(decimal) followers: string;
  @ApiProperty(decimal) following: string;
  @ApiProperty(decimal) blocked: string;
}
export class GraphConnectionsDto extends GraphProjectionDto {
  @ApiProperty(decimal) generation: string;
  @ApiProperty() account: string;
  @ApiProperty({ type: [String] }) addresses: string[];
  @ApiProperty({ type: [SocialGraphAccountDto] })
  items: SocialGraphAccountDto[];
  @ApiProperty({ type: String, nullable: true }) next_cursor: string | null;
}
export class GraphRelationshipDto extends SocialGraphRelationshipDto {
  @ApiProperty() network: string;
  @ApiProperty() contract: string;
  @ApiProperty() block_hash: string;
  @ApiProperty(decimal) height: string;
  @ApiProperty() from: string;
  @ApiProperty() to: string;
  @ApiProperty() frozen: boolean;
  @ApiProperty() importing: boolean;
  @ApiProperty({ enum: [true] }) advisory: boolean;
}
export class GraphPageDto extends GraphIdentityDto {
  @ApiProperty() block_hash: string;
  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { Follow: { type: 'array', items: { type: 'string' } } },
          required: ['Follow'],
        },
        {
          type: 'object',
          properties: { Block: { type: 'array', items: { type: 'string' } } },
          required: ['Block'],
        },
        {
          type: 'object',
          properties: { Rate: { type: 'array', items: { type: 'string' } } },
          required: ['Rate'],
        },
      ],
    },
  })
  items: unknown[];
  @ApiProperty({ type: String, nullable: true }) next_cursor: string | null;
  @ApiProperty(decimal) end_cursor: string;
}
export class GraphPrecheckDto extends GraphSnapshotDto {
  @ApiProperty({
    enum: [true],
    description:
      'A simulation is not authorization or a guarantee of transaction inclusion.',
  })
  advisory: boolean;
  @ApiProperty({ enum: ['passed', 'rejected'] }) simulation: string;
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty({ type: Number, nullable: true }) suggested_http_status:
    number | null;
  @ApiProperty(decimal) config_version: string;
  @ApiProperty(decimal) gas_used: string;
}

export class GraphStatusDto extends GraphProjectionDto {
  @ApiProperty({ type: String, nullable: true }) generation: string | null;
  @ApiProperty({
    enum: ['uninitialized', 'importing', 'catching-up', 'ready', 'rebuilding'],
  })
  state: string;
  @ApiProperty({ type: String, nullable: true }) snapshot_height: string | null;
  @ApiProperty({ type: String, nullable: true }) source_contract: string | null;
  @ApiProperty({ type: String, nullable: true }) source_cutoff: string | null;
  @ApiProperty({ type: String, nullable: true }) activation_height:
    string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Verified receipt identifiers; legacy mode also records the explicit owner-trust boundary.',
  })
  migration_evidence: Record<string, unknown> | null;
}

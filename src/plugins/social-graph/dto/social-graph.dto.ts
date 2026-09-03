import { ApiProperty } from '@nestjs/swagger';
import { IsIn, Matches } from 'class-validator';

export type SocialGraphAction = 'follow' | 'unfollow' | 'block' | 'unblock';

export const SOCIAL_GRAPH_ACTIONS: SocialGraphAction[] = [
  'follow',
  'unfollow',
  'block',
  'unblock',
];

// æternity account address: base58 payload after the `ak_` prefix.
export const AE_ADDRESS_REGEX = /^ak_[1-9A-HJ-NP-Za-km-z]+$/;

export class SocialGraphRelationshipDto {
  @ApiProperty({ description: '`from` follows `to`.' })
  a_follows_b: boolean;

  @ApiProperty({ description: '`to` follows `from`.' })
  b_follows_a: boolean;

  @ApiProperty({ description: '`from` has blocked `to`.' })
  a_blocked_b: boolean;

  @ApiProperty({ description: '`to` has blocked `from`.' })
  b_blocked_a: boolean;
}

export class SocialGraphConfigDto {
  @ApiProperty({ description: 'Max concurrent following list size.' })
  max_following: number;

  @ApiProperty({ description: 'Max concurrent blocked list size.' })
  max_blocked: number;

  @ApiProperty({
    description: 'Blocks between consecutive follows, in blocks. 0 = no limit.',
  })
  follow_cooldown: number;

  @ApiProperty({ description: 'The indexed contract address.' })
  contract_address: string;
}

export class SocialGraphPrecheckDto {
  @ApiProperty({
    enum: SOCIAL_GRAPH_ACTIONS,
    description: 'The write the client is about to sign.',
  })
  @IsIn(SOCIAL_GRAPH_ACTIONS)
  action: SocialGraphAction;

  @ApiProperty({ example: 'ak_...', description: 'The signing caller.' })
  @Matches(AE_ADDRESS_REGEX)
  from: string;

  @ApiProperty({ example: 'ak_...', description: 'The target address.' })
  @Matches(AE_ADDRESS_REGEX)
  to: string;
}

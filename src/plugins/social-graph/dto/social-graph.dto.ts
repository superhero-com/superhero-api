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

// Profile fields for one row of a followers/following list. Mirrors the shape
// ProfileReadService serves for a single account, so both clients render a list
// row from the same fields they already use on a profile — no per-row lookup.
export class SocialGraphAccountProfileDto {
  @ApiProperty({ nullable: true })
  fullname: string;

  @ApiProperty({ nullable: true })
  bio: string;

  @ApiProperty({ nullable: true, type: String })
  site: string | null;

  @ApiProperty({ nullable: true })
  avatarurl: string;

  @ApiProperty({ nullable: true, type: String })
  username: string | null;

  @ApiProperty({ nullable: true, type: String })
  prefered_aens_name: string | null;

  @ApiProperty({ nullable: true, type: String })
  x_username: string | null;

  @ApiProperty({ nullable: true, type: String })
  chain_name: string | null;

  @ApiProperty({ nullable: true, type: String })
  chain_expires_at: string | null;
}

export class SocialGraphAccountDto {
  @ApiProperty({ example: 'ak_...' })
  address: string;

  @ApiProperty({ type: SocialGraphAccountProfileDto })
  profile: SocialGraphAccountProfileDto;

  @ApiProperty({
    description: 'Best display name (preferred AENS → chain name → address).',
  })
  public_name: string;
}

export class SocialGraphConnectionsPageDto {
  @ApiProperty({ type: [SocialGraphAccountDto] })
  items: SocialGraphAccountDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Opaque cursor for the next page; pass back as `cursor`. `null` on the ' +
      'last page.',
  })
  next_cursor: string | null;
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

import { ApiProperty } from '@nestjs/swagger';
import type {
  RoomMembershipRelayState,
  RoomMembershipRole,
} from '../entities/room-membership.entity';

/**
 * One token-gated room the caller is eligible for (Task 13 Req 1). Joins
 * `community_room` metadata with the caller's own `room_membership` row so the
 * client knows both the room shape AND whether it can actually read it.
 *
 * Field style is **snake_case** (mirrors `TokenDto` / `PreferenceView`, repo
 * CLAUDE.md). `min_token_threshold` is raw integer base units as a string
 * (`Token.decimals` is a string; never lose precision through a JS number).
 */
export class RoomViewDto {
  @ApiProperty({
    example: 'ct_2sZ...',
    description: 'NIP-29 group id = the token sale address (verbatim, D3).',
  })
  sale_address: string;

  @ApiProperty({
    example: 'ct_...',
    description: 'AEX9 token contract address.',
  })
  token_address: string;

  @ApiProperty({ example: 'WORDS' })
  symbol: string;

  @ApiProperty({ example: true })
  is_private: boolean;

  @ApiProperty({
    example: '1000000000000000000',
    description: 'Minimum balance to be eligible, raw integer base units.',
  })
  min_token_threshold: string;

  @ApiProperty({ example: false })
  is_community: boolean;

  @ApiProperty({ enum: ['member', 'admin'], example: 'member' })
  role: RoomMembershipRole;

  @ApiProperty({
    enum: ['pending_add', 'added', 'pending_remove', 'removed'],
    example: 'added',
  })
  relay_state: RoomMembershipRelayState;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'a1b2...',
    description:
      'Resolved hex Nostr pubkey, or null until the holder links one.',
  })
  member_pubkey: string | null;

  @ApiProperty({
    example: true,
    description:
      "True iff the member is actually published on the relay (relay_state='added' AND member_pubkey set). When false, show the §16 'link your Nostr key' fallback.",
  })
  readable: boolean;
}

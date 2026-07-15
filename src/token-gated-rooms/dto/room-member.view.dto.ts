import { ApiProperty } from '@nestjs/swagger';
import type {
  RoomMembershipRelayState,
  RoomMembershipRole,
} from '../entities/room-membership.entity';

/**
 * One member of a room (Task 13 Req 2). Deliberately carries NO balance — holder
 * balances/holder lists are `tokens.controller.ts :address/holders`. snake_case
 * to match the rest of the public surface.
 */
export class RoomMemberViewDto {
  @ApiProperty({ example: 'ak_2sZ...' })
  member_address: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'a1b2...',
    description:
      'Resolved hex Nostr pubkey, or null until the holder links one.',
  })
  member_pubkey: string | null;

  @ApiProperty({ enum: ['member', 'admin'], example: 'member' })
  role: RoomMembershipRole;

  @ApiProperty({
    enum: ['pending_add', 'added', 'pending_remove', 'removed'],
    example: 'added',
  })
  relay_state: RoomMembershipRelayState;

  @ApiProperty({ example: true })
  eligible: boolean;
}

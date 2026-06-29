import { ApiProperty } from '@nestjs/swagger';

/**
 * Current room-mute state for an `(address, sale_address)` pair (Task 13 Req 5/6).
 * Two layers: per-room `muted` and the type-level `mute_all` (the `room-messages`
 * switch). Both default to `false` (opt-out model — silent only when explicitly set).
 */
export class RoomMuteViewDto {
  @ApiProperty({
    example: false,
    description:
      'Per-room mute for this (address, sale_address). Default false (no row = not muted).',
  })
  muted: boolean;

  @ApiProperty({
    example: false,
    description:
      "Mute-all for room messages (the type-level `room-messages` switch). True iff that type is disabled. Suppresses EVERY room's message pushes.",
  })
  mute_all: boolean;
}

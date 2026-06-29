import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { IsAeAccountAddress } from '@/common/validation/request-validation';

/**
 * Signed body for `POST /api/rooms/:saleAddress/mute` (Task 13 Req 5). Mirrors
 * `UpdatePreferencesDto` but carries `address` IN THE BODY (the route varies only
 * by `:saleAddress`), validated as an `ak_…`. The signature binds to the
 * intent-specific, body-hashed room-mute message (see `room-mute.message.ts`), so
 * a captured prefs/device signature — or a swapped `muted`/`mute_all` — is rejected.
 */
export class UpdateRoomMuteDto {
  @ApiProperty({ example: 'ak_2sZ...' })
  @IsAeAccountAddress()
  address: string;

  @ApiProperty({
    description: 'Nonce returned by POST /rooms/:saleAddress/mute/challenge',
  })
  @IsString()
  nonce: string;

  @ApiProperty({
    description: 'Signature of the room-mute message (sg_... or hex)',
  })
  @IsString()
  signature: string;

  @ApiProperty({ description: 'Mute this specific room for this address.' })
  @IsBoolean()
  muted: boolean;

  @ApiProperty({
    required: false,
    description:
      'Optional: also toggle mute-all for room messages (the type-level `room-messages` switch). Omit to leave the type-level switch untouched.',
  })
  @IsOptional()
  @IsBoolean()
  mute_all?: boolean;
}

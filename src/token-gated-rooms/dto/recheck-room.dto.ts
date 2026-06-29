import { IsAeAccountAddress } from '@/common/validation/request-validation';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for `POST /rooms/:saleAddress/recheck` — the caller's AE address. The room
 * is the route param; the recheck heals/provisions that address's membership.
 */
export class RecheckRoomDto {
  @ApiProperty({ example: 'ak_2sZ...' })
  @IsAeAccountAddress()
  address: string;
}

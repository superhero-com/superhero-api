import { IsAeAccountAddress } from '@/common/validation/request-validation';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for both challenge-issue endpoints (device-link and preferences-update).
 * Identical shape — only the address is needed; the intent is distinguished by
 * the endpoint and by the message format the client rebuilds and signs.
 */
export class RequestChallengeDto {
  @ApiProperty({ example: 'ak_2sZ...' })
  @IsAeAccountAddress()
  address: string;
}

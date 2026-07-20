import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * Body for `POST :address/feed/session`. The address is taken from the path
 * param; the caller signs `buildFeedSessionMessage(address, nonce)` and submits
 * the nonce + signature to exchange for a bearer session.
 */
export class CreateFeedSessionDto {
  @ApiProperty({
    description:
      'Nonce returned by POST /notifications/:address/feed/challenge',
  })
  @IsString()
  nonce: string;

  @ApiProperty({
    description: 'Signature of the session message (sg_... or hex)',
  })
  @IsString()
  signature: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** The browser-supplied encryption keys from `PushSubscription.toJSON().keys`. */
export class WebPushKeysDto {
  @ApiProperty({ description: 'Client public key (base64url).' })
  @IsString()
  @MaxLength(255)
  p256dh: string;

  @ApiProperty({ description: 'Client auth secret (base64url).' })
  @IsString()
  @MaxLength(255)
  auth: string;
}

/**
 * Body for `POST :address/web-push/subscription`. Shape matches the browser's
 * `PushSubscription.toJSON()` ({ endpoint, keys: { p256dh, auth } }) so the
 * frontend can post it almost verbatim.
 */
export class CreateWebPushSubscriptionDto {
  @ApiProperty({
    description: 'Push service endpoint URL for this subscription.',
  })
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2048)
  endpoint: string;

  @ApiProperty({ type: WebPushKeysDto })
  @IsObject()
  @ValidateNested()
  @Type(() => WebPushKeysDto)
  keys: WebPushKeysDto;

  @ApiPropertyOptional({
    description: 'Subscribing browser user-agent (diagnostics).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;
}

/** Body for `DELETE :address/web-push/subscription`. */
export class DeleteWebPushSubscriptionDto {
  @ApiProperty({ description: 'The endpoint of the subscription to remove.' })
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2048)
  endpoint: string;
}

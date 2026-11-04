import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { parsePushEndpoint, pushServiceHosts } from '../web-push/push-endpoint';

function IsPushServiceEndpoint(): PropertyDecorator {
  return ValidateBy({
    name: 'isPushServiceEndpoint',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        parsePushEndpoint(value, pushServiceHosts()) !== null,
      defaultMessage: () =>
        'endpoint must be an https URL on a browser push service',
    },
  });
}

// Same byte-length rule web-push applies when it encrypts, so a key it would
// reject at send time is refused here instead of failing every notification.
function HasDecodedLength(
  accepts: (bytes: number) => boolean,
  message: string,
): PropertyDecorator {
  return ValidateBy({
    name: 'hasDecodedLength',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        accepts(Buffer.from(value, 'base64url').length),
      defaultMessage: () => message,
    },
  });
}

/** The browser-supplied encryption keys from `PushSubscription.toJSON().keys`. */
export class WebPushKeysDto {
  @ApiProperty({ description: 'Client public key (base64url).' })
  @IsString()
  @MaxLength(255)
  @HasDecodedLength(
    (bytes) => bytes === 65,
    'p256dh must be a base64url P-256 public key (65 bytes)',
  )
  p256dh: string;

  @ApiProperty({ description: 'Client auth secret (base64url).' })
  @IsString()
  @MaxLength(255)
  @HasDecodedLength(
    (bytes) => bytes >= 16,
    'auth must be a base64url secret of at least 16 bytes',
  )
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
  @IsPushServiceEndpoint()
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

/**
 * Body for `DELETE :address/web-push/subscription`. Deliberately not limited to
 * push-service hosts, so rows stored before that check can still be removed.
 */
export class DeleteWebPushSubscriptionDto {
  @ApiProperty({ description: 'The endpoint of the subscription to remove.' })
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2048)
  endpoint: string;
}

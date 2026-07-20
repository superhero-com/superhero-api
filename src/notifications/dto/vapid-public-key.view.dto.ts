import { ApiProperty } from '@nestjs/swagger';

/** Response of `GET /notifications/web-push/vapid-public-key`. */
export class VapidPublicKeyView {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'VAPID application server public key (base64url) for pushManager.subscribe, or null when web push is not configured.',
  })
  publicKey: string | null;
}

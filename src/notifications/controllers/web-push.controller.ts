import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { AeAccountAddressPipe } from '@/common/validation/request-validation';
import notificationsConfig from '../notifications.config';
import { FeedSessionGuard } from '../guards/feed-session.guard';
import { WebPushSubscriptionService } from '../services/web-push-subscription.service';
import { WebPushClient } from '../web-push/web-push.client';
import {
  CreateWebPushSubscriptionDto,
  DeleteWebPushSubscriptionDto,
} from '../dto/web-push-subscription.dto';
import { VapidPublicKeyView } from '../dto/vapid-public-key.view.dto';

/**
 * Browser Web Push (VAPID) subscription management. The public key route is open
 * (the frontend needs it to call `pushManager.subscribe`); subscribe/unsubscribe
 * reuse the feed-session bearer (`FeedSessionGuard`) and are scoped to the path
 * address — no separate signing flow, since the web app already holds a session.
 */
@ApiTags('notifications')
@Controller('notifications')
export class WebPushController {
  constructor(
    private readonly subscriptions: WebPushSubscriptionService,
    private readonly client: WebPushClient,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  /**
   * The VAPID application-server public key the browser subscribes with.
   * Returns null (rather than a key that will never send) whenever the
   * channel isn't actually configured — e.g. `VAPID_PUBLIC_KEY` is set but
   * `VAPID_PRIVATE_KEY` is missing/malformed — so the frontend doesn't call
   * `pushManager.subscribe()` against a channel that can't deliver.
   */
  @Get('web-push/vapid-public-key')
  @UseGuards(RateLimitGuard)
  @ApiOkResponse({ type: VapidPublicKeyView })
  vapidPublicKey(): VapidPublicKeyView {
    return {
      publicKey: this.client.isConfigured()
        ? (this.config.vapidPublicKey ?? null)
        : null,
    };
  }

  /** Register/refresh this browser's push subscription for the address. */
  @Post(':address/web-push/subscription')
  @HttpCode(200)
  @UseGuards(FeedSessionGuard)
  async subscribe(
    @Param('address', AeAccountAddressPipe) address: string,
    @Body() dto: CreateWebPushSubscriptionDto,
  ): Promise<{ ok: true }> {
    await this.subscriptions.upsert(address, {
      endpoint: dto.endpoint,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      userAgent: dto.userAgent ?? null,
    });
    return { ok: true };
  }

  /** Remove this browser's push subscription (logout / push disabled). */
  @Delete(':address/web-push/subscription')
  @HttpCode(200)
  @UseGuards(FeedSessionGuard)
  async unsubscribe(
    @Param('address', AeAccountAddressPipe) address: string,
    @Body() dto: DeleteWebPushSubscriptionDto,
  ): Promise<{ ok: true }> {
    await this.subscriptions.remove(address, dto.endpoint);
    return { ok: true };
  }
}

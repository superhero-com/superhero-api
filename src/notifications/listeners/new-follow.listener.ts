import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Encoded } from '@aeternity/aepp-sdk';
import {
  SOCIAL_GRAPH_FOLLOWED_EVENT,
  SocialGraphFollowedEventPayload,
} from '@/plugins/social-graph/events';
import { NotificationService } from '../core/notification.service';
import { AccountLabelService } from '../services/account-label.service';
import { NewFollowNotification } from '../notifications/new-follow.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges SOCIAL_GRAPH_FOLLOWED_EVENT from the social-graph plugin into the
 * notification engine so the followed account is told "<X> started following
 * you". The plugin already gates the emit on a new follow indexed live (never
 * unfollow, block, backfill/replay, or an idempotent duplicate), so this only
 * adds defensive self-follow / missing-recipient guards. The opt-out is enforced
 * in NotificationService.send; ExpoChannel no-ops when there is no device token.
 */
@Injectable()
export class NewFollowListener {
  private readonly logger = new Logger(NewFollowListener.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @OnEvent(SOCIAL_GRAPH_FOLLOWED_EVENT, { async: true, promisify: true })
  async onFollowed(payload: SocialGraphFollowedEventPayload): Promise<void> {
    try {
      if (!this.config.enabled) {
        return;
      }
      const { followerAddress, followedAddress, txHash } = payload;
      if (!followerAddress || !followedAddress || !txHash) {
        return;
      }
      if (followerAddress === followedAddress) {
        return;
      }

      const followerLabel = await this.accountLabel.labelFor(followerAddress);
      const outcome = await this.notifications.send(
        { address: followedAddress as Encoded.AccountAddress },
        new NewFollowNotification({
          follower: followerAddress,
          followed: followedAddress,
          txHash,
          followerLabel,
        }),
      );
      if (outcome.outcome === 'failed') {
        this.logger.warn(
          `New-follow notification failed for ${followedAddress}: ${outcome.error}`,
        );
      }
    } catch (error) {
      this.logger.error('Failed to process new-follow event', error as Error);
    }
  }
}

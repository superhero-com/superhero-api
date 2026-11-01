import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Encoded } from '@aeternity/aepp-sdk';
import {
  POST_MENTION_EVENT,
  PostMentionEventPayload,
} from '@/plugins/social/events';
import { NotificationService } from '../core/notification.service';
import { AccountLabelService } from '../services/account-label.service';
import { NotificationRedisService } from '../services/notification-redis.service';
import { NotificationPreferencesService } from '../services/notification-preferences.service';
import { PostMentionNotification } from '../notifications/post-mention.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges POST_MENTION_EVENT from the social plugin into the notification
 * engine: each tagged account is told "<X> mentioned you in a post". Skips the
 * author and, for a comment, the parent post author (post-comment already
 * tells them). Posting is cheap, so each recipient has a fixed-window rate cap
 * (checked after the opt-out, as in PostCommentListener).
 */
@Injectable()
export class PostMentionListener {
  private readonly logger = new Logger(PostMentionListener.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    private readonly redis: NotificationRedisService,
    private readonly preferences: NotificationPreferencesService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @OnEvent(POST_MENTION_EVENT, { async: true, promisify: true })
  async onMentioned(payload: PostMentionEventPayload): Promise<void> {
    try {
      if (!this.config.enabled) {
        return;
      }
      const { authorAddress, postId, txHash } = payload;
      if (!authorAddress || !postId || !txHash) {
        return;
      }
      const recipients = [...new Set(payload.mentionedAddresses ?? [])].filter(
        (address) =>
          !!address &&
          address !== authorAddress &&
          address !== payload.parentAuthorAddress,
      );
      if (!recipients.length) {
        return;
      }

      let authorLabel: string | undefined;
      for (const recipient of recipients) {
        if (!(await this.mayNotify(recipient))) {
          continue;
        }
        authorLabel ??= await this.accountLabel.labelFor(authorAddress);
        const outcome = await this.notifications.send(
          { address: recipient as Encoded.AccountAddress },
          new PostMentionNotification({
            mentioned: recipient,
            author: authorAddress,
            postId,
            txHash,
            authorLabel,
          }),
        );
        if (outcome.outcome === 'failed') {
          this.logger.warn(
            `Mention notification failed for ${recipient}: ${outcome.error}`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Failed to process post-mention event', error as Error);
    }
  }

  /** Opt-out first, then the per-recipient cap (fails open on Redis trouble). */
  private async mayNotify(recipient: string): Promise<boolean> {
    if (
      !(await this.preferences.isEnabled(
        recipient,
        PostMentionNotification.META.type,
      ))
    ) {
      return false;
    }
    try {
      const { capped } = await this.redis.incrementWithCap(
        `notif:rate:post-mention:${recipient}`,
        this.config.postMentionRateWindowSec,
        this.config.postMentionRateCap,
      );
      return !capped;
    } catch (rateError) {
      this.logger.warn(
        `Post-mention rate-cap check failed for ${recipient} — failing open: ${(rateError as Error).message}`,
      );
      return true;
    }
  }
}

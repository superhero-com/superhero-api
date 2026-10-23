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
import { NotificationGateService } from '../services/notification-gate.service';
import { PostMentionNotification } from '../notifications/post-mention.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges POST_MENTION_EVENT from the social plugin into the notification
 * engine: each tagged account is told "<X> mentioned you in a post". The
 * emitter already drops the author and a comment's parent author. Posting is
 * cheap, so each recipient goes through the opt-out + rate-cap gate.
 */
@Injectable()
export class PostMentionListener {
  private readonly logger = new Logger(PostMentionListener.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    private readonly gate: NotificationGateService,
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
      const recipients = new Set(payload.mentionedAddresses);
      recipients.delete(authorAddress);

      let authorLabel: string | undefined;
      for (const recipient of recipients) {
        if (
          !(await this.gate.mayNotify(
            recipient,
            PostMentionNotification.META.type,
            {
              cap: this.config.postMentionRateCap,
              windowSec: this.config.postMentionRateWindowSec,
            },
          ))
        ) {
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
}

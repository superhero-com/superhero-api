import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Encoded } from '@aeternity/aepp-sdk';
import {
  POST_COMMENT_CREATED_EVENT,
  PostCommentCreatedEventPayload,
} from '@/plugins/social/events';
import { NotificationService } from '../core/notification.service';
import { AccountLabelService } from '../services/account-label.service';
import { NotificationGateService } from '../services/notification-gate.service';
import { PostCommentNotification } from '../notifications/post-comment.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges POST_COMMENT_CREATED_EVENT from the social plugin into the
 * notification engine. NOT gated on the recipient having a mobile device:
 * post-comment also delivers to the web feed (the 'database' channel), so a
 * web-only post author must still be dispatched. ExpoChannel no-ops when there
 * is no device token, the opt-out is enforced in NotificationService.send, and
 * the per-recipient rate cap (NotificationGateService) bounds a comment storm.
 */
@Injectable()
export class PostCommentListener {
  private readonly logger = new Logger(PostCommentListener.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    private readonly gate: NotificationGateService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @OnEvent(POST_COMMENT_CREATED_EVENT, { async: true, promisify: true })
  async onCommented(payload: PostCommentCreatedEventPayload): Promise<void> {
    try {
      if (!this.config.enabled) {
        return;
      }
      const {
        postAuthorAddress,
        commenterAddress,
        parentPostId,
        commentId,
        txHash,
      } = payload;
      if (!postAuthorAddress || !commenterAddress || !txHash) {
        return;
      }
      if (postAuthorAddress === commenterAddress) {
        return;
      }

      if (
        !(await this.gate.mayNotify(
          postAuthorAddress,
          PostCommentNotification.META.type,
          {
            cap: this.config.postCommentRateCap,
            windowSec: this.config.postCommentRateWindowSec,
          },
        ))
      ) {
        return;
      }

      const commenterLabel = await this.accountLabel.labelFor(commenterAddress);
      const outcome = await this.notifications.send(
        { address: postAuthorAddress as Encoded.AccountAddress },
        new PostCommentNotification({
          postAuthor: postAuthorAddress,
          commenter: commenterAddress,
          parentPostId,
          commentId,
          txHash,
          commenterLabel,
        }),
      );
      if (outcome.outcome === 'failed') {
        this.logger.warn(
          `Post-comment notification failed for ${postAuthorAddress}: ${outcome.error}`,
        );
      }
    } catch (error) {
      this.logger.error('Failed to process post-comment event', error as Error);
    }
  }
}

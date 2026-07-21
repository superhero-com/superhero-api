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
import { NotificationRedisService } from '../services/notification-redis.service';
import { NotificationPreferencesService } from '../services/notification-preferences.service';
import { PostCommentNotification } from '../notifications/post-comment.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges POST_COMMENT_CREATED_EVENT from the social plugin into the
 * notification engine. NOT gated on the recipient having a mobile device:
 * post-comment also delivers to the web feed (the 'database' channel), so a
 * web-only post author must still be dispatched. ExpoChannel no-ops when there
 * is no device token, the opt-out is enforced in NotificationService.send, and
 * the per-recipient rate cap below still bounds a comment storm.
 */
@Injectable()
export class PostCommentListener {
  private readonly logger = new Logger(PostCommentListener.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    private readonly redis: NotificationRedisService,
    private readonly preferences: NotificationPreferencesService,
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

      // Preferences chokepoint BEFORE the rate cap: otherwise an opted-out
      // author "spends" their per-window budget without ever receiving a
      // notification, and a later re-enable lands silently capped. Mirror the
      // chokepoint NotificationService.send applies — the duplicate query is
      // cheap (one indexed lookup) and the alternative is a confusing UX.
      if (
        !(await this.preferences.isEnabled(
          postAuthorAddress,
          PostCommentNotification.META.type,
        ))
      ) {
        return;
      }

      // Per-recipient fixed-window cap: each unique comment is a distinct
      // txHash, so the per-(notification, recipient) dedup never coalesces a
      // coordinated comment storm. Tune via
      // NOTIF_POST_COMMENT_RATE_CAP / NOTIF_POST_COMMENT_RATE_WINDOW_SEC.
      //
      // Fail-open on Redis trouble: if the increment throws (Redis down, script
      // error), we still attempt the notification rather than silently dropping
      // it. The downstream NotificationService has its own Redis dependencies
      // (preferences, dedup), so this only matters for narrow partial outages.
      let capped = false;
      let count = 0;
      try {
        const result = await this.redis.incrementWithCap(
          `notif:rate:post-comment:${postAuthorAddress}`,
          this.config.postCommentRateWindowSec,
          this.config.postCommentRateCap,
        );
        capped = result.capped;
        count = result.count;
      } catch (rateError) {
        this.logger.warn(
          `Post-comment rate-cap check failed for ${postAuthorAddress} — failing open: ${(rateError as Error).message}`,
        );
      }
      if (capped) {
        // Log when count crosses the cap (vs strict-equal to cap+1): handles
        // mid-window cap-tightening and process restart cleanly. The boundary
        // condition `count - 1 <= cap` is true on exactly the first event that
        // pushed count above cap, regardless of how it got there.
        if (count - 1 <= this.config.postCommentRateCap) {
          this.logger.warn(
            `Post-comment rate cap hit for ${postAuthorAddress} (${this.config.postCommentRateCap}/${this.config.postCommentRateWindowSec}s) — further comments will be dropped until the window resets`,
          );
        }
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

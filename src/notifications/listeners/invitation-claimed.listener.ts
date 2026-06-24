import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Encoded } from '@aeternity/aepp-sdk';
import {
  INVITATION_CLAIMED_EVENT,
  InvitationClaimedEventPayload,
} from '@/plugins/bcl-affiliation/events';
import { NotificationService } from '../core/notification.service';
import { AccountLabelService } from '../services/account-label.service';
import { InvitationClaimedNotification } from '../notifications/invitation-claimed.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges INVITATION_CLAIMED_EVENT from the bcl-affiliation plugin into the
 * notification engine. Unlike the SpendTx trigger, this is NOT gated on the
 * recipient having a mobile device: invitation-claimed also delivers to the web
 * feed (the 'database' channel), so a web-only inviter must still be dispatched.
 * The per-channel fan-out stays cheap on its own — ExpoChannel no-ops when the
 * recipient has no device token, and the opt-out is enforced in
 * NotificationService.send. These events are bounded (one per redeemed invite),
 * so there is no hot-path flood to guard against.
 */
@Injectable()
export class InvitationClaimedListener {
  private readonly logger = new Logger(InvitationClaimedListener.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @OnEvent(INVITATION_CLAIMED_EVENT, { async: true, promisify: true })
  async onClaimed(payload: InvitationClaimedEventPayload): Promise<void> {
    try {
      if (!this.config.enabled) {
        return;
      }
      const { inviterAddress, claimerAddress, txHash, amountAe } = payload;
      if (!inviterAddress || !claimerAddress || !txHash) {
        return;
      }
      if (inviterAddress === claimerAddress) {
        return;
      }

      const claimerLabel = await this.accountLabel.labelFor(claimerAddress);
      const outcome = await this.notifications.send(
        { address: inviterAddress as Encoded.AccountAddress },
        new InvitationClaimedNotification({
          inviter: inviterAddress,
          claimer: claimerAddress,
          amountAe,
          txHash,
          claimerLabel,
        }),
      );
      if (outcome.outcome === 'failed') {
        this.logger.warn(
          `Invitation-claimed notification failed for ${inviterAddress}: ${outcome.error}`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Failed to process invitation-claimed event',
        error as Error,
      );
    }
  }
}

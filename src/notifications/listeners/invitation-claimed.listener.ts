import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Encoded } from '@aeternity/aepp-sdk';
import {
  INVITATION_CLAIMED_EVENT,
  InvitationClaimedEventPayload,
} from '@/plugins/bcl-affiliation/events';
import { NotificationService } from '../core/notification.service';
import { DeviceRegistryService } from '../services/device-registry.service';
import { AccountLabelService } from '../services/account-label.service';
import { InvitationClaimedNotification } from '../notifications/invitation-claimed.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges INVITATION_CLAIMED_EVENT from the bcl-affiliation plugin into the
 * notification engine. Cheap hot-path gate: short-circuits if the inviter has
 * no registered device before doing any label resolution.
 */
@Injectable()
export class InvitationClaimedListener {
  private readonly logger = new Logger(InvitationClaimedListener.name);

  constructor(
    private readonly registry: DeviceRegistryService,
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
      if (!(await this.registry.hasDevices(inviterAddress))) {
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

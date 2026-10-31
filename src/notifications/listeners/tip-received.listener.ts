import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Encoded } from '@aeternity/aepp-sdk';
import {
  TIP_RECEIVED_EVENT,
  TipReceivedEventPayload,
} from '@/plugins/social-tipping/events';
import { NotificationService } from '../core/notification.service';
import { AccountLabelService } from '../services/account-label.service';
import { TipReceivedNotification } from '../notifications/tip-received.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges TIP_RECEIVED_EVENT from the social-tipping plugin into the
 * notification engine so the receiver is told "<X> tipped you N AE". The
 * plugin already gates the emit on a live, committed, non-self tip; this adds
 * defensive guards only. The opt-out is enforced in NotificationService.send.
 * Tips cost the sender AE, so no extra rate cap is needed.
 */
@Injectable()
export class TipReceivedListener {
  private readonly logger = new Logger(TipReceivedListener.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @OnEvent(TIP_RECEIVED_EVENT, { async: true, promisify: true })
  async onTipReceived(payload: TipReceivedEventPayload): Promise<void> {
    try {
      if (!this.config.enabled) {
        return;
      }
      const { senderAddress, receiverAddress, txHash } = payload;
      if (!senderAddress || !receiverAddress || !txHash) {
        return;
      }
      if (senderAddress === receiverAddress) {
        return;
      }

      const senderLabel = await this.accountLabel.labelFor(senderAddress);
      const outcome = await this.notifications.send(
        { address: receiverAddress as Encoded.AccountAddress },
        new TipReceivedNotification({
          receiver: receiverAddress,
          sender: senderAddress,
          amountAe: payload.amountAe,
          postId: payload.postId,
          txHash,
          senderLabel,
        }),
      );
      if (outcome.outcome === 'failed') {
        this.logger.warn(
          `Tip notification failed for ${receiverAddress}: ${outcome.error}`,
        );
      }
    } catch (error) {
      this.logger.error('Failed to process tip-received event', error as Error);
    }
  }
}

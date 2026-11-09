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
import { NotificationGateService } from '../services/notification-gate.service';
import { TipReceivedNotification } from '../notifications/tip-received.notification';
import notificationsConfig from '../notifications.config';

/**
 * Bridges TIP_RECEIVED_EVENT from the social-tipping plugin into the
 * notification engine so the receiver is told "<X> tipped you N AE". The
 * plugin already gates the emit on a live, committed, non-self tip. A 1-aetto
 * tip costs little more than the fee, so tips below the anti-dust floor are
 * dropped and the rest go through the opt-out + rate-cap gate.
 */
@Injectable()
export class TipReceivedListener {
  private readonly logger = new Logger(TipReceivedListener.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    private readonly gate: NotificationGateService,
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
      if (this.parseAettos(payload.amountAettos) < this.minAmountAettos()) {
        return;
      }
      if (
        !(await this.gate.mayNotify(
          receiverAddress,
          TipReceivedNotification.META.type,
          {
            cap: this.config.tipReceivedRateCap,
            windowSec: this.config.tipReceivedRateWindowSec,
          },
        ))
      ) {
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

  /** The shared transfer floor, but never below 1 aetto: a 0-AE tip is noise. */
  private minAmountAettos(): bigint {
    const floor = this.config.minAmountAettos;
    return floor > 1n ? floor : 1n;
  }

  private parseAettos(raw: string | undefined): bigint {
    try {
      return BigInt(raw ?? '0');
    } catch {
      return 0n;
    }
  }
}

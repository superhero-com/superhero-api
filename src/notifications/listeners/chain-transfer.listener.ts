import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Encoded, toAe } from '@aeternity/aepp-sdk';
import { LIVE_TX_EVENT, LiveTxEventPayload } from '@/mdw-sync/events';
import { NotificationService } from '../core/notification.service';
import { DeviceRegistryService } from '../services/device-registry.service';
import { AccountLabelService } from '../services/account-label.service';
import { IncomingTransferNotification } from '../notifications/incoming-transfer.notification';
import notificationsConfig from '../notifications.config';

/**
 * The hot-path trigger. For every live transaction it does at most one O(1) Redis
 * membership check before bailing, so it stays cheap at full chain throughput.
 * All heavier work is downstream (dedup + queued Expo send). It NEVER throws back
 * into the indexer.
 */
@Injectable()
export class ChainTransferListener {
  private readonly logger = new Logger(ChainTransferListener.name);

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly notifications: NotificationService,
    private readonly accountLabel: AccountLabelService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @OnEvent(LIVE_TX_EVENT, { async: true, promisify: true })
  async onLiveTx(tx: LiveTxEventPayload): Promise<void> {
    try {
      if (!this.config.enabled) {
        return;
      }
      if (tx.type !== 'SpendTx') {
        return;
      }

      const recipient = tx.recipient_id;
      const sender = tx.sender_id;
      if (!recipient || !sender || recipient === sender) {
        return;
      }

      // The dedup key is (txHash, recipient). Without a real tx hash the key
      // collapses to ':<recipient>' for every hashless event, which would dedup
      // every subsequent hashless event to the same recipient for the whole
      // TTL window. Refuse to dispatch instead.
      if (!tx.hash) {
        this.logger.warn(
          'Skipping live-tx notification: missing tx.hash on SpendTx payload',
        );
        return;
      }

      const amount = this.parseAmount(tx.raw?.amount);
      if (amount < this.config.minAmountAettos) {
        return;
      }

      // The only work performed for the overwhelming majority of transactions.
      if (!(await this.registry.hasDevices(recipient))) {
        return;
      }

      const senderLabel = await this.accountLabel.labelFor(sender);
      const outcome = await this.notifications.send(
        { address: recipient as Encoded.AccountAddress },
        new IncomingTransferNotification({
          recipient,
          sender,
          amountAe: toAe(amount.toString()),
          txHash: tx.hash,
          senderLabel,
        }),
      );
      if (outcome.outcome === 'failed') {
        this.logger.warn(
          `Incoming-transfer notification failed for ${recipient}: ${outcome.error}`,
        );
      }
    } catch (error) {
      // Notifications must never break indexing.
      this.logger.error(
        'Failed to process live tx for notification',
        error as Error,
      );
    }
  }

  private parseAmount(raw: unknown): bigint {
    try {
      if (raw === undefined || raw === null) {
        return 0n;
      }
      return BigInt(typeof raw === 'number' ? Math.trunc(raw) : String(raw));
    } catch {
      return 0n;
    }
  }
}

import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Inject, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Job, Queue } from 'bull';
import { ExpoPushClient, ExpoPushMessage } from '../expo/expo-push.client';
import { DeviceService } from '../services/device.service';
import { NotificationRedisService } from '../services/notification-redis.service';
import { NotificationDedupService } from '../services/notification-dedup.service';
import { REDIS_KEYS } from '../notifications.constants';
import notificationsConfig from '../notifications.config';
import { SendExpoJob } from '../channels/expo.channel';
import {
  EXPO_RECEIPT_JOB_OPTIONS,
  EXPO_RECEIPT_QUEUE,
  SEND_EXPO_NOTIFICATION_QUEUE,
} from './constants';

interface ReceiptJob {
  ticketIds: string[];
}

/**
 * Sends ONE Expo-sized chunk per Bull job. The producer (ExpoChannel) splits
 * tokens into chunks before enqueue, so each job holds at most expoPushBatchSize
 * tokens — a retry of a failed job re-sends only its chunk, never any chunks
 * that already succeeded in a previous job.
 */
@Processor(SEND_EXPO_NOTIFICATION_QUEUE)
export class SendExpoNotificationQueue {
  private readonly logger = new Logger(SendExpoNotificationQueue.name);

  constructor(
    private readonly expo: ExpoPushClient,
    private readonly deviceService: DeviceService,
    private readonly redis: NotificationRedisService,
    private readonly dedup: NotificationDedupService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
    @InjectQueue(EXPO_RECEIPT_QUEUE)
    private readonly receiptQueue: Queue<ReceiptJob>,
  ) {}

  @Process({ concurrency: 5 })
  async process(job: Job<SendExpoJob>): Promise<void> {
    try {
      await this.deliver(job.data);
    } catch (error) {
      // On the LAST attempt, drop the dedup marker so a later re-observation
      // (e.g. reorg replay) can re-deliver instead of being suppressed for the
      // full dedupTtl. Earlier attempts keep the marker so Bull's own retry of
      // THIS job doesn't double-send. Best-effort: a release failure just means
      // the marker expires on its TTL as before.
      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;
      if (isFinalAttempt && job.data.dedupKey) {
        await this.dedup
          .release(job.data.dedupKey)
          .catch((releaseError) =>
            this.logger.warn(
              `Failed to release dedup key "${job.data.dedupKey}" after exhausted retries: ${
                (releaseError as Error).message
              }`,
            ),
          );
      }
      throw error;
    }
  }

  private async deliver(data: SendExpoJob): Promise<void> {
    const { tokens, content } = data;
    const messages: ExpoPushMessage[] = tokens
      .filter((token) => this.expo.isExpoPushToken(token))
      .map((to) => ({
        to,
        sound: 'default',
        title: content.title,
        body: content.body,
        data: content.data,
      }));

    if (messages.length === 0) {
      return;
    }

    const tickets = await this.expo.sendPushNotificationsAsync(messages);
    const ticketIds: string[] = [];

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const to = messages[i]?.to;
      if (ticket.status === 'ok' && ticket.id) {
        ticketIds.push(ticket.id);
        // Remember which token a ticket maps to, for receipt-time pruning.
        await this.redis.setEx(
          REDIS_KEYS.ticketToken(ticket.id),
          to,
          this.config.receiptDelayMs + 10 * 60 * 1000,
        );
      } else if (ticket.status === 'error') {
        if (ticket.details?.error === 'DeviceNotRegistered' && to) {
          await this.deviceService.pruneToken(to);
        } else {
          this.logger.warn(
            `Expo ticket error for ${to}: ${ticket.message ?? 'unknown'}`,
          );
        }
      }
    }

    if (ticketIds.length > 0) {
      await this.receiptQueue.add(
        { ticketIds },
        { ...EXPO_RECEIPT_JOB_OPTIONS, delay: this.config.receiptDelayMs },
      );
    }
  }
}

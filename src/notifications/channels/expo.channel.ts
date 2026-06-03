import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Queue } from 'bull';
import { Notifiable } from '../core/notifiable.interface';
import { AppNotification } from '../core/notification.interface';
import { NotificationChannel } from '../core/notification-channel.interface';
import { ExpoMessageContent } from '../core/notification.interface';
import { DeviceService } from '../services/device.service';
import { NotificationDedupService } from '../services/notification-dedup.service';
import notificationsConfig from '../notifications.config';
import {
  SEND_EXPO_JOB_OPTIONS,
  SEND_EXPO_NOTIFICATION_QUEUE,
} from '../queues/constants';

export interface SendExpoJob {
  tokens: string[];
  content: ExpoMessageContent;
  /**
   * The logical dedup key acquired before enqueue. Carried so the processor can
   * release it if the chunk exhausts its retries, letting a later re-observation
   * re-deliver instead of being permanently suppressed by the held marker.
   */
  dedupKey: string;
}

/**
 * Expo push channel. Resolves the recipient's device tokens, applies idempotency,
 * and enqueues the actual send so no network I/O happens on the caller's thread.
 *
 * Chunking happens HERE (producer-side), not in the consumer. Each chunk becomes
 * its own Bull job — a retry of a failed chunk re-sends only that chunk, not
 * earlier chunks that already succeeded.
 */
@Injectable()
export class ExpoChannel implements NotificationChannel {
  readonly name = 'expo' as const;

  constructor(
    private readonly deviceService: DeviceService,
    private readonly dedup: NotificationDedupService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
    @InjectQueue(SEND_EXPO_NOTIFICATION_QUEUE)
    private readonly queue: Queue<SendExpoJob>,
  ) {}

  async send(
    notifiable: Notifiable,
    notification: AppNotification,
  ): Promise<void> {
    const tokens = await this.deviceService.getActiveTokens(notifiable.address);
    if (tokens.length === 0) {
      return;
    }

    const dedupKey = `${notification.type}:${notification.dedupKey(notifiable)}`;
    const acquired = await this.dedup.tryAcquire(dedupKey);
    if (!acquired) {
      return;
    }

    const content = notification.toExpo(notifiable);
    const batchSize = Math.max(1, this.config.expoPushBatchSize);
    for (let i = 0; i < tokens.length; i += batchSize) {
      const chunk = tokens.slice(i, i + batchSize);
      await this.queue.add(
        { tokens: chunk, content, dedupKey },
        SEND_EXPO_JOB_OPTIONS,
      );
    }
  }
}

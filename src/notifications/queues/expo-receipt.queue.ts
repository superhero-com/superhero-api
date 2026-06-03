import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ExpoPushClient } from '../expo/expo-push.client';
import { DeviceService } from '../services/device.service';
import { NotificationRedisService } from '../services/notification-redis.service';
import { REDIS_KEYS } from '../notifications.constants';
import { EXPO_RECEIPT_QUEUE } from './constants';

interface ReceiptJob {
  ticketIds: string[];
}

/**
 * Polls Expo delivery receipts. This is where most dead tokens surface: a
 * DeviceNotRegistered receipt prunes the token it mapped to.
 */
@Processor(EXPO_RECEIPT_QUEUE)
export class ExpoReceiptQueue {
  private readonly logger = new Logger(ExpoReceiptQueue.name);

  constructor(
    private readonly expo: ExpoPushClient,
    private readonly deviceService: DeviceService,
    private readonly redis: NotificationRedisService,
  ) {}

  @Process({ concurrency: 3 })
  async process(job: Job<ReceiptJob>): Promise<void> {
    const idChunks = this.expo.chunkReceiptIds(job.data.ticketIds);

    for (const ids of idChunks) {
      const receipts = await this.expo.getPushNotificationReceiptsAsync(ids);
      for (const [id, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error') {
          if (receipt.details?.error === 'DeviceNotRegistered') {
            const token = await this.redis.get(REDIS_KEYS.ticketToken(id));
            if (token) {
              await this.deviceService.pruneToken(token);
            }
          }
          this.logger.warn(
            `Expo receipt error ${id}: ${receipt.message ?? 'unknown'}`,
          );
        }
        await this.redis.del(REDIS_KEYS.ticketToken(id));
      }
    }
  }
}

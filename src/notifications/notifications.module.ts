import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '@/account/entities/account.entity';
import { DeviceToken } from './entities/device-token.entity';
import { DeviceChallenge } from './entities/device-challenge.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import notificationsConfig from './notifications.config';
import { NOTIFICATION_CHANNELS } from './notifications.constants';
import {
  EXPO_RECEIPT_QUEUE,
  SEND_EXPO_NOTIFICATION_QUEUE,
} from './queues/constants';
import { NotificationService } from './core/notification.service';
import { ExpoChannel } from './channels/expo.channel';
import { ExpoPushClient } from './expo/expo-push.client';
import { NotificationRedisService } from './services/notification-redis.service';
import { DeviceRegistryService } from './services/device-registry.service';
import { NotificationDedupService } from './services/notification-dedup.service';
import { DeviceChallengeService } from './services/device-challenge.service';
import { DeviceService } from './services/device.service';
import { AccountLabelService } from './services/account-label.service';
import { NotificationPreferencesService } from './services/notification-preferences.service';
import { ChainTransferListener } from './listeners/chain-transfer.listener';
import { InvitationClaimedListener } from './listeners/invitation-claimed.listener';
import { PostCommentListener } from './listeners/post-comment.listener';
import { SendExpoNotificationQueue } from './queues/send-expo-notification.queue';
import { ExpoReceiptQueue } from './queues/expo-receipt.queue';
import { DevicesController } from './controllers/devices.controller';
import { PreferencesController } from './controllers/preferences.controller';

/**
 * Rate ceiling for the Expo send queue, read at module load (Bull needs it at
 * registration time). Bull's limiter only PACES jobs — a throttled job waits
 * for the next window, it is never dropped — so a conservative default is safe.
 * Tune `EXPO_SEND_RATE_MAX` / `EXPO_SEND_RATE_DURATION_MS` to the Expo limits
 * negotiated for this app (an Expo access token raises them).
 */
function expoSendLimiter(): { max: number; duration: number } {
  const max = Number.parseInt(process.env.EXPO_SEND_RATE_MAX ?? '', 10);
  const duration = Number.parseInt(
    process.env.EXPO_SEND_RATE_DURATION_MS ?? '',
    10,
  );
  return {
    max: Number.isFinite(max) && max > 0 ? max : 50,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 1000,
  };
}

/**
 * Notification engine + Expo push delivery + signed device registration + the live
 * transfer trigger. `NotificationService` is exported so other modules can dispatch
 * their own notifications.
 */
@Module({
  imports: [
    ConfigModule.forFeature(notificationsConfig),
    TypeOrmModule.forFeature([
      DeviceToken,
      DeviceChallenge,
      NotificationPreference,
      Account,
    ]),
    BullModule.registerQueue(
      { name: SEND_EXPO_NOTIFICATION_QUEUE, limiter: expoSendLimiter() },
      { name: EXPO_RECEIPT_QUEUE },
    ),
  ],
  controllers: [DevicesController, PreferencesController],
  providers: [
    NotificationService,
    NotificationRedisService,
    DeviceRegistryService,
    NotificationDedupService,
    DeviceChallengeService,
    DeviceService,
    AccountLabelService,
    NotificationPreferencesService,
    ExpoPushClient,
    ExpoChannel,
    SendExpoNotificationQueue,
    ExpoReceiptQueue,
    ChainTransferListener,
    InvitationClaimedListener,
    PostCommentListener,
    // Channel registry: append a provider here to add a channel.
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (expo: ExpoChannel) => [expo],
      inject: [ExpoChannel],
    },
  ],
  exports: [NotificationService, DeviceService, NotificationPreferencesService],
})
export class NotificationsModule {}

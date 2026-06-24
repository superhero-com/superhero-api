import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '@/account/entities/account.entity';
import { DeviceToken } from './entities/device-token.entity';
import { DeviceChallenge } from './entities/device-challenge.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationRecord } from './entities/notification.entity';
import { WebPushSubscription } from './entities/web-push-subscription.entity';
import notificationsConfig from './notifications.config';
import { NOTIFICATION_CHANNELS } from './notifications.constants';
import {
  EXPO_RECEIPT_QUEUE,
  SEND_EXPO_NOTIFICATION_QUEUE,
  SEND_WEB_PUSH_QUEUE,
} from './queues/constants';
import { NotificationService } from './core/notification.service';
import { ExpoChannel } from './channels/expo.channel';
import { DatabaseChannel } from './channels/database.channel';
import { WebPushChannel } from './channels/web-push.channel';
import { ExpoPushClient } from './expo/expo-push.client';
import { WebPushClient } from './web-push/web-push.client';
import { NotificationRedisService } from './services/notification-redis.service';
import { DeviceRegistryService } from './services/device-registry.service';
import { NotificationDedupService } from './services/notification-dedup.service';
import { DeviceChallengeService } from './services/device-challenge.service';
import { DeviceService } from './services/device.service';
import { AccountLabelService } from './services/account-label.service';
import { NotificationPreferencesService } from './services/notification-preferences.service';
import { NotificationFeedService } from './services/notification-feed.service';
import { WebPushSubscriptionService } from './services/web-push-subscription.service';
import { FeedSessionService } from './services/feed-session.service';
import { FeedRetentionService } from './services/feed-retention.service';
import { NotificationsGateway } from './notifications.gateway';
import { FeedSessionGuard } from './guards/feed-session.guard';
import { ChainTransferListener } from './listeners/chain-transfer.listener';
import { InvitationClaimedListener } from './listeners/invitation-claimed.listener';
import { PostCommentListener } from './listeners/post-comment.listener';
import { SendExpoNotificationQueue } from './queues/send-expo-notification.queue';
import { ExpoReceiptQueue } from './queues/expo-receipt.queue';
import { SendWebPushQueue } from './queues/send-web-push.queue';
import { DevicesController } from './controllers/devices.controller';
import { PreferencesController } from './controllers/preferences.controller';
import { FeedController } from './controllers/feed.controller';
import { WebPushController } from './controllers/web-push.controller';

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
 * Rate ceiling for the Web Push send queue, same paced-not-dropped semantics as
 * the Expo limiter. Browser push services (FCM/Mozilla/Apple) are forgiving but
 * a conservative default avoids hammering them under a notification burst. Tune
 * via `WEB_PUSH_SEND_RATE_MAX` / `WEB_PUSH_SEND_RATE_DURATION_MS`.
 */
function webPushSendLimiter(): { max: number; duration: number } {
  const max = Number.parseInt(process.env.WEB_PUSH_SEND_RATE_MAX ?? '', 10);
  const duration = Number.parseInt(
    process.env.WEB_PUSH_SEND_RATE_DURATION_MS ?? '',
    10,
  );
  return {
    max: Number.isFinite(max) && max > 0 ? max : 100,
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
      NotificationRecord,
      WebPushSubscription,
      Account,
    ]),
    BullModule.registerQueue(
      { name: SEND_EXPO_NOTIFICATION_QUEUE, limiter: expoSendLimiter() },
      { name: EXPO_RECEIPT_QUEUE },
      { name: SEND_WEB_PUSH_QUEUE, limiter: webPushSendLimiter() },
    ),
  ],
  controllers: [
    DevicesController,
    PreferencesController,
    FeedController,
    WebPushController,
  ],
  providers: [
    NotificationService,
    NotificationRedisService,
    DeviceRegistryService,
    NotificationDedupService,
    DeviceChallengeService,
    DeviceService,
    AccountLabelService,
    NotificationPreferencesService,
    NotificationFeedService,
    WebPushSubscriptionService,
    FeedSessionService,
    FeedRetentionService,
    NotificationsGateway,
    FeedSessionGuard,
    ExpoPushClient,
    WebPushClient,
    ExpoChannel,
    DatabaseChannel,
    WebPushChannel,
    SendExpoNotificationQueue,
    ExpoReceiptQueue,
    SendWebPushQueue,
    ChainTransferListener,
    InvitationClaimedListener,
    PostCommentListener,
    // Channel registry: append a provider here to add a channel.
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (
        expo: ExpoChannel,
        database: DatabaseChannel,
        webPush: WebPushChannel,
      ) => [expo, database, webPush],
      inject: [ExpoChannel, DatabaseChannel, WebPushChannel],
    },
  ],
  exports: [NotificationService, DeviceService, NotificationPreferencesService],
})
export class NotificationsModule {}

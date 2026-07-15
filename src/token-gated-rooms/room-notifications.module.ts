import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationsModule } from '@/notifications/notifications.module';
import notificationsConfig from '@/notifications/notifications.config';
import { NotificationRedisService } from '@/notifications/services/notification-redis.service';
import tgrConfig from './config/tgr.config';
import { CommunityRoom } from './entities/community-room.entity';
import { RoomMembership } from './entities/room-membership.entity';
import { RoomMembershipEvent } from './entities/room-membership-event.entity';
import { RoomMessageSeen } from './entities/room-message-seen.entity';
import { RoomNotificationPreference } from './entities/room-notification-preference.entity';
import { RoomPreferencesService } from './services/room-preferences.service';
import { RoomEventListener } from './listeners/room-event.listener';
import { RoomNotifyProcessor } from './queues/room-notify.processor';
import { RoomMessageNotifyProcessor } from './queues/room-message-notify.processor';
import { RelaySubscriberService } from './nostr/relay-subscriber.service';
import { ROOM_NOTIFY_QUEUE } from './queues/room-notify.types';

/**
 * Membership notifications + per-room mute (plan §7.2).
 *
 * Plain self-contained `@Module` (worker mode removed — see `deworker-plan.md`).
 * Everything loads in the single process: `RoomPreferencesService` (the read/write
 * surface the HTTP controller needs), the membership-push fan-out (listener +
 * `worker:room-notify` queue + its two processors), and the Task 14 relay READ
 * subscriber. The subscriber + the dispatch path self-gate at runtime on
 * `isRelayConfigured` (no relay → no socket, nothing enqueued), so this module is
 * safe to load unconditionally. As a plain `@Module` it is a NestJS singleton, so
 * the `worker:room-notify` queue is registered exactly once even though both
 * `TokenGatedRoomsModule` and `ClientRoomApiModule` import it.
 *
 * Boot-safe: nothing schedules work in `onModuleInit`; the listener only enqueues
 * on an event and the processors only run on jobs.
 */
@Module({
  imports: [
    ConfigModule.forFeature(tgrConfig),
    ConfigModule.forFeature(notificationsConfig),
    TypeOrmModule.forFeature([
      Token,
      RoomNotificationPreference,
      CommunityRoom,
      RoomMembership,
      RoomMembershipEvent,
      RoomMessageSeen,
    ]),
    NotificationsModule,
    BullModule.registerQueue({ name: ROOM_NOTIFY_QUEUE }),
  ],
  providers: [
    RoomPreferencesService,
    NotificationRedisService,
    RoomEventListener,
    RoomNotifyProcessor,
    RelaySubscriberService,
    RoomMessageNotifyProcessor,
  ],
  exports: [RoomPreferencesService],
})
export class RoomNotificationsModule {}

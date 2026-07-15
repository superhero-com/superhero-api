import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '@/notifications/notifications.module';
import notificationsConfig from '@/notifications/notifications.config';
import { DeviceChallenge } from '@/notifications/entities/device-challenge.entity';
import { DeviceChallengeService } from '@/notifications/services/device-challenge.service';
import tgrConfig from './config/tgr.config';
import { CommunityRoom } from './entities/community-room.entity';
import { RoomMembership } from './entities/room-membership.entity';
import { RoomNotificationsModule } from './room-notifications.module';
import { RoomsController } from './controllers/rooms.controller';
import { RoomsQueryService } from './services/rooms-query.service';
import { RoomMuteService } from './services/room-mute.service';

/**
 * Client room API — the HTTP surface for token-gated rooms.
 *
 * Plain self-contained `@Module` (worker mode removed — see `deworker-plan.md`).
 * HTTP always runs in the single process, so the controller always mounts.
 *
 * ## Why it provides DeviceChallengeService locally
 * `NotificationsModule` exports `NotificationPreferencesService` but NOT
 * `DeviceChallengeService`. To reuse the exact signed-challenge flow without
 * editing the notifications wiring, this module re-provides `DeviceChallengeService`
 * (its only deps are the `DeviceChallenge` repo + `notificationsConfig`, both
 * imported here). Its `@Cron cleanupExpired` sweep is multi-instance safe — it
 * takes a `pg_try_advisory_xact_lock` so only one instance deletes per tick.
 *
 * Reuse, not re-provide, for the rest:
 *   - `NotificationPreferencesService` ← `NotificationsModule` export (mute-all);
 *   - `RoomPreferencesService` ← `RoomNotificationsModule` export (per-room mute).
 *
 * `RoomNotificationsModule` is a plain `@Module` (NestJS singleton), so nesting it
 * here as well as in `TokenGatedRoomsModule` registers its `worker:room-notify`
 * queue + processors exactly once — no double-registration.
 *
 * Boot-safe: nothing schedules work or opens a socket in `onModuleInit`.
 */
@Module({
  imports: [
    ConfigModule.forFeature(tgrConfig),
    ConfigModule.forFeature(notificationsConfig),
    TypeOrmModule.forFeature([CommunityRoom, RoomMembership, DeviceChallenge]),
    NotificationsModule,
    RoomNotificationsModule,
  ],
  controllers: [RoomsController],
  providers: [RoomsQueryService, RoomMuteService, DeviceChallengeService],
})
export class ClientRoomApiModule {}

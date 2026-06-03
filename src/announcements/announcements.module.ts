import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '@/notifications/notifications.module';
import { Announcement } from './entities/announcement.entity';
import { AnnouncementTarget } from './entities/announcement-target.entity';
import announcementsConfig from './announcements.config';
import { AnnouncementService } from './services/announcement.service';
import { AnnouncementDispatchService } from './services/announcement-dispatch.service';
import { AnnouncementSchedulerService } from './scheduler/announcement-scheduler.service';
import { AnnouncementSignalService } from './scheduler/announcement-signal.service';
import { AnnouncementsController } from './controllers/announcements.controller';

/**
 * Announcements: admin-authored, scheduled push + a public in-app feed. The admin
 * app inserts rows directly into the DB; this module's scheduler claims due rows and
 * fans them out through the notification engine (NotificationService + DeviceService,
 * imported from NotificationsModule).
 */
@Module({
  imports: [
    ConfigModule.forFeature(announcementsConfig),
    TypeOrmModule.forFeature([Announcement, AnnouncementTarget]),
    NotificationsModule,
  ],
  controllers: [AnnouncementsController],
  providers: [
    AnnouncementService,
    AnnouncementDispatchService,
    AnnouncementSchedulerService,
    AnnouncementSignalService,
  ],
})
export class AnnouncementsModule {}

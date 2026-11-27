import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ProfileMediaCoreModule } from './profile-media-core.module';
import { ProfileMediaWorker } from './profile-media-worker.service';
import { ProfileMediaAssets } from './profile-media-assets.service';
import { ProfileMediaEncoder } from './profile-media-encoder.service';
import { ProfileMediaStorage } from './profile-media-storage.service';
import { ProfileMediaEdgeController } from './profile-media-edge.controller';
import { ProfileMediaGate } from './profile-media.controller';
import { privateBucketConfig } from '../shorts/shorts-private-objects.service';
import {
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';
import { ProfileMediaCleanup } from './profile-media-cleanup.service';
import {
  PROFILE_MEDIA_CLEANUP_BUCKET,
  ProfileMediaSourceCleanup,
} from './profile-media-source-cleanup.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...DATABASE_CONFIG,
      synchronize: false,
      autoLoadEntities: false,
      logging: false,
      extra: { ...DATABASE_CONFIG.extra, max: 2, min: 0 },
    }),
    ScheduleModule.forRoot(),
    ProfileMediaCoreModule,
  ],
  providers: [
    ProfileMediaWorker,
    ProfileMediaCleanup,
    ProfileMediaSourceCleanup,
    {
      provide: PROFILE_MEDIA_CLEANUP_BUCKET,
      inject: [PROFILE_MEDIA_CONFIG],
      useFactory: async (config: ProfileMediaConfig) =>
        config.enabled
          ? privateBucketConfig({
              ...process.env,
              SHORTS_PRIVATE_S3_CREDENTIALS_FILE:
                process.env.PROFILE_MEDIA_CLEANUP_S3_CREDENTIALS_FILE,
            })
          : null,
    },
    ProfileMediaAssets,
    ProfileMediaEncoder,
    ProfileMediaStorage,
    ProfileMediaGate,
  ],
  controllers: [ProfileMediaEdgeController],
})
export class ProfileMediaWorkerModule {}

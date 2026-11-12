import { Module } from '@nestjs/common';
import {
  privateObjectConfig,
  ShortsPrivateObjectsService,
} from '../shorts/shorts-private-objects.service';
import {
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
  profileMediaConfig,
} from './profile-media.config';
import { ProfileMediaDatabase } from './profile-media-database.service';
import { ProfileMediaAuth } from './profile-media-auth.service';
import {
  PROFILE_MEDIA_OBJECTS,
  ProfileMediaUploads,
} from './profile-media-uploads.service';

@Module({
  providers: [
    { provide: PROFILE_MEDIA_CONFIG, useFactory: profileMediaConfig },
    {
      provide: PROFILE_MEDIA_OBJECTS,
      inject: [PROFILE_MEDIA_CONFIG],
      useFactory: async (config: ProfileMediaConfig) =>
        config.enabled
          ? new ShortsPrivateObjectsService(await privateObjectConfig())
          : null,
    },
    ProfileMediaDatabase,
    ProfileMediaAuth,
    ProfileMediaUploads,
  ],
  exports: [
    PROFILE_MEDIA_CONFIG,
    PROFILE_MEDIA_OBJECTS,
    ProfileMediaDatabase,
    ProfileMediaAuth,
    ProfileMediaUploads,
  ],
})
export class ProfileMediaCoreModule {}

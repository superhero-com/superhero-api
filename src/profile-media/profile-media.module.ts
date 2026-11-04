import { PostMediaService } from './post-media.service';
import { Module } from '@nestjs/common';
import { ProfileMediaCoreModule } from './profile-media-core.module';
import { ProfileMediaChain } from './profile-media-chain.service';
import { ProfileMediaService } from './profile-media.service';
import { ProfileMediaRetention } from './profile-media-retention.service';
import {
  ProfileMediaController,
  ProfileMediaGate,
  ProfileMediaSession,
} from './profile-media.controller';

@Module({
  imports: [ProfileMediaCoreModule],
  providers: [
    ProfileMediaChain,
    ProfileMediaService,
    PostMediaService,
    ProfileMediaRetention,
    ProfileMediaGate,
    ProfileMediaSession,
  ],
  controllers: [ProfileMediaController],
  exports: [ProfileMediaService],
})
export class ProfileMediaModule {}

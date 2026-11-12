import { Module } from '@nestjs/common';
import {
  SHORTS_LIKE_SPONSOR_CONFIG,
  likeSponsorConfig,
} from './shorts-like-sponsorship.config';
import { ShortsLikeSponsorshipRepository } from './shorts-like-sponsorship-repository.service';
import { ShortsLikeSponsorWorker } from './shorts-like-sponsor-worker.service';

@Module({
  providers: [
    {
      provide: SHORTS_LIKE_SPONSOR_CONFIG,
      useFactory: () => likeSponsorConfig(true),
    },
    ShortsLikeSponsorshipRepository,
    ShortsLikeSponsorWorker,
  ],
})
export class ShortsLikeSponsorModule {}

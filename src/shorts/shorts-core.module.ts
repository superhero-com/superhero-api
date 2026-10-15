import { Module } from '@nestjs/common';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsStoreService } from './shorts-store.service';
import { ShortsWorkQueueService } from './shorts-work-queue.service';
import { ShortsReceiptsService } from './shorts-receipts.service';
import { ShortsNodeAccessService } from './shorts-node-access.service';

@Module({
  providers: [
    ShortsChainService,
    ShortsNodeAccessService,
    ShortsStoreService,
    ShortsWorkQueueService,
    ShortsReceiptsService,
  ],
  exports: [ShortsChainService, ShortsStoreService],
})
export class ShortsCoreModule {}

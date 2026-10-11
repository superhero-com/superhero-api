import { Module } from '@nestjs/common';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsStoreService } from './shorts-store.service';

@Module({
  providers: [ShortsChainService, ShortsStoreService],
  exports: [ShortsChainService, ShortsStoreService],
})
export class ShortsCoreModule {}

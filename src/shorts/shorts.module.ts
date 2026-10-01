import { ShortsUploadsService } from './shorts-uploads.service';
import { ShortsSafetyService } from './shorts-safety.service';
import { ShortsAnalyticsService } from './shorts-analytics.service';
import { ShortsLedgerService } from './shorts-ledger.service';
import { ShortsLabelsService } from './shorts-labels.service';
import { ShortsStoreService } from './shorts-store.service';
import { ShortsAuthService } from './shorts-auth.service';
import { Module } from '@nestjs/common';
import { ShortsController } from './shorts.controller';
import { ShortsService } from './shorts.service';
import { ShortsHostingService } from './shorts-hosting.service';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsMediaService } from './shorts-media.service';

// Deliberately absent from AppModule. Explicit local bootstrap only.
@Module({
  controllers: [ShortsController],
  providers: [
    ShortsSafetyService,
    ShortsUploadsService,
    ShortsAnalyticsService,
    ShortsLedgerService,
    ShortsLabelsService,
    ShortsStoreService,
    ShortsAuthService,
    ShortsChainService,
    ShortsMediaService,
    ShortsService,
    ShortsHostingService,
  ],
})
export class ShortsTestnetModule {}

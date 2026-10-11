import { ShortsStreamingService } from './shorts-streaming.service';
import { ShortsUploadsService } from './shorts-uploads.service';
import { ShortsSafetyService } from './shorts-safety.service';
import { ShortsAnalyticsService } from './shorts-analytics.service';
import { ShortsLedgerService } from './shorts-ledger.service';
import { ShortsLabelsService } from './shorts-labels.service';
import { ShortsAuthService } from './shorts-auth.service';
import { DynamicModule, Module } from '@nestjs/common';
import { ShortsCoreModule } from './shorts-core.module';
import { ShortsController } from './shorts.controller';
import { ShortsService } from './shorts.service';
import { ShortsHostingService } from './shorts-hosting.service';
import { ShortsMediaService } from './shorts-media.service';

// Loaded by the opt-in feature module or the loopback-only development entrypoint.
@Module({
  imports: [ShortsCoreModule],
  controllers: [ShortsController],
  providers: [
    ShortsStreamingService,
    ShortsSafetyService,
    ShortsUploadsService,
    ShortsAnalyticsService,
    ShortsLabelsService,
    ShortsAuthService,
    ShortsMediaService,
    ShortsService,
    ShortsHostingService,
  ],
})
export class ShortsTestnetModule {
  static async register(indexed = false): Promise<DynamicModule> {
    if (indexed) {
      if (process.env.AE_NETWORK_ID !== 'ae_uat')
        throw new Error('Hosted Shorts indexing requires AE_NETWORK_ID=ae_uat');
      const { ShortsIndexModule } = await import('./shorts-index.module');
      const { ShortsIndexService } = await import('./shorts-index.service');
      return {
        module: ShortsTestnetModule,
        imports: [ShortsIndexModule],
        providers: [
          { provide: ShortsLedgerService, useExisting: ShortsIndexService },
        ],
      };
    }
    if (process.env.NODE_ENV === 'production')
      throw new Error('Local ledger is unavailable in production');
    const { LocalShortsLedgerService } = await import('./local-ledger.service');
    return {
      module: ShortsTestnetModule,
      providers: [
        { provide: ShortsLedgerService, useClass: LocalShortsLedgerService },
      ],
    };
  }
}

import { ShortsStreamingService } from './shorts-streaming.service';
import { ShortsUploadsService } from './shorts-uploads.service';
import { ShortsSafetyService } from './shorts-safety.service';
import {
  ShortsAnalyticsService,
  LocalShortsAnalyticsService,
} from './shorts-analytics.service';
import { ShortsLedgerService } from './shorts-ledger.service';
import { ShortsLabelsService } from './shorts-labels.service';
import { ShortsAuthService } from './shorts-auth.service';
import { ShortsAuthGuard } from './shorts-auth.guard';
import { ShortsUploadInterceptor } from './shorts-upload.interceptor';
import { DynamicModule, Module } from '@nestjs/common';
import { ShortsCoreModule } from './shorts-core.module';
import { ShortsController } from './shorts.controller';
import { ShortsService } from './shorts.service';
import { ShortsHostingService } from './shorts-hosting.service';
import { ShortsMediaService } from './shorts-media.service';
import { ShortsUploadLimitsService } from './shorts-upload-limits.service';
import { ShortsRecordsService } from './shorts-records.service';
import { ShortsWalletTransactionsService } from './shorts-wallet-transactions.service';
import { ShortsPlaybackEvidenceService } from './shorts-playback-evidence.service';
import { ShortsMeasurementMonitorService } from './shorts-measurement-monitor.service';
import { ShortsCommentsService } from './shorts-comments.service';
import {
  SHORTS_LIKE_SPONSOR_CONFIG,
  likeSponsorConfig,
} from './shorts-like-sponsorship.config';
import { ShortsLikeSponsorshipRepository } from './shorts-like-sponsorship-repository.service';
import { ShortsLikeSponsorshipService } from './shorts-like-sponsorship.service';

// Loaded by the opt-in feature module or the loopback-only development entrypoint.
@Module({
  imports: [ShortsCoreModule],
  controllers: [ShortsController],
  providers: [
    {
      provide: SHORTS_LIKE_SPONSOR_CONFIG,
      useFactory: () => likeSponsorConfig(),
    },
    ShortsLikeSponsorshipRepository,
    ShortsLikeSponsorshipService,
    ShortsCommentsService,
    ShortsRecordsService,
    ShortsWalletTransactionsService,
    ShortsPlaybackEvidenceService,
    ShortsMeasurementMonitorService,
    ShortsUploadLimitsService,
    ShortsStreamingService,
    ShortsSafetyService,
    ShortsUploadsService,
    { provide: ShortsAnalyticsService, useClass: LocalShortsAnalyticsService },
    ShortsLabelsService,
    ShortsAuthService,
    ShortsAuthGuard,
    ShortsUploadInterceptor,
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
      const { ShortsMetadataModule } = await import('./shorts-metadata.module');
      const { ShortsRateModule } = await import('./shorts-rate.module');
      const { ShortsSharedUploadsModule } =
        await import('./shorts-shared-uploads.module');
      const { ShortsHostedUploadsService } =
        await import('./shorts-hosted-uploads.service');
      const { ShortsHostedAnalyticsService } =
        await import('./shorts-hosted-analytics.service');
      const { ShortsPublicationBoundaryModule } =
        await import('./shorts-publication-boundary.module');
      const { ShortsApiPublicationService } =
        await import('./shorts-api-publication.service');
      const { ShortsHostedHostingService } =
        await import('./shorts-hosted-hosting.service');
      const { ShortsLifecycleJobsService } =
        await import('./shorts-lifecycle-jobs.service');
      const { ShortsStudioReadService } =
        await import('./shorts-studio-read.service');
      const { ShortsHostedBootstrapService } =
        await import('./shorts-hosted-bootstrap.service');
      const { ShortsFollowingService } =
        await import('./shorts-following.service');
      const { ShortsReconciliationService } =
        await import('./shorts-reconciliation.service');
      return {
        module: ShortsTestnetModule,
        imports: [
          ShortsIndexModule,
          ShortsRateModule,
          ShortsMetadataModule,
          ShortsSharedUploadsModule,
          ShortsPublicationBoundaryModule,
        ],
        providers: [
          ShortsReconciliationService,
          ShortsFollowingService,
          ShortsHostedBootstrapService,
          ShortsApiPublicationService,
          ShortsStudioReadService,
          ShortsLifecycleJobsService,
          {
            provide: ShortsHostingService,
            useClass: ShortsHostedHostingService,
          },
          {
            provide: ShortsAnalyticsService,
            useClass: ShortsHostedAnalyticsService,
          },
          { provide: ShortsLedgerService, useExisting: ShortsIndexService },
          {
            provide: ShortsUploadsService,
            useClass: ShortsHostedUploadsService,
          },
        ],
      };
    }
    if (process.env.NODE_ENV === 'production')
      throw new Error('Local ledger is unavailable in production');
    const { LocalShortsLedgerService } = await import('./local-ledger.service');
    const { ShortsEncodingModule } = await import('./shorts-encoding.module');
    return {
      module: ShortsTestnetModule,
      imports: [ShortsEncodingModule],
      providers: [
        { provide: ShortsLedgerService, useClass: LocalShortsLedgerService },
      ],
    };
  }
}

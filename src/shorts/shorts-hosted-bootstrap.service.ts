import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ShortsApiPublicationService } from './shorts-api-publication.service';
import { ShortsUploadsService } from './shorts-uploads.service';
import { ShortsHostedUploadsService } from './shorts-hosted-uploads.service';
import { ShortsAnalyticsService } from './shorts-analytics.service';
import { ShortsHostedAnalyticsService } from './shorts-hosted-analytics.service';
import { ShortsStreamingService } from './shorts-streaming.service';
import { ShortsHostingService } from './shorts-hosting.service';
import { ShortsHostedHostingService } from './shorts-hosted-hosting.service';

/** Complete readiness in order before background work can compete for SQL. */
@Injectable()
export class ShortsHostedBootstrapService implements OnApplicationBootstrap {
  constructor(
    private readonly publication: ShortsApiPublicationService,
    @Inject(ShortsUploadsService)
    private readonly uploads: ShortsHostedUploadsService,
    @Inject(ShortsAnalyticsService)
    private readonly analytics: ShortsHostedAnalyticsService,
    private readonly streaming: ShortsStreamingService,
    @Inject(ShortsHostingService)
    private readonly hosting: ShortsHostedHostingService,
  ) {}
  async onApplicationBootstrap() {
    await this.publication.initialize();
    await this.uploads.initialize();
    await this.analytics.initialize();
    await this.streaming.initialize();
    await this.hosting.initialize();
    this.analytics.start();
    this.streaming.start();
    this.hosting.start();
  }
}

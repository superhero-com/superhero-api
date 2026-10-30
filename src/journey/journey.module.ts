import { AffiliationModule } from '@/affiliation/affiliation.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JourneyEvent } from './entities/journey-event.entity';
import { JourneyIngestBuffer } from './journey-ingest.buffer';
import { JourneyQueryService } from './journey-query.service';
import { JourneyRetentionService } from './journey-retention.service';
import {
  JourneyDashboardController,
  JourneyIngestController,
} from './journey.controller';

/**
 * Anonymous user-journey analytics: public ingest, storage, funnel and page
 * flow queries, and the operator dashboard.
 *
 * Imported in AppModule BEFORE AnalyticsModule so `/analytics/journey/*` is
 * registered ahead of anything on `/analytics/:something` (Express matches in
 * registration order).
 */
@Module({
  imports: [AffiliationModule, TypeOrmModule.forFeature([JourneyEvent])],
  providers: [
    JourneyIngestBuffer,
    JourneyQueryService,
    JourneyRetentionService,
  ],
  controllers: [JourneyIngestController, JourneyDashboardController],
})
export class JourneyModule {}

import { ShortsDatabaseModule } from './shorts-database.module';
import { Module } from '@nestjs/common';
import { ShortsMetadataService } from './shorts-metadata.service';
import { ShortsSessionsService } from './shorts-sessions.service';
import { ShortsLegacyImportsService } from './shorts-legacy-imports.service';
import { ShortsStreamJobsService } from './shorts-stream-jobs.service';
import { ShortsMeasurementsService } from './shorts-measurements.service';

// Shared PostgreSQL comes from the normal API or a dedicated worker's TypeORM
// module. This module has no dependency on SQLite, wallets or media decoders.
@Module({
  imports: [ShortsDatabaseModule],
  providers: [
    ShortsMetadataService,
    ShortsSessionsService,
    ShortsLegacyImportsService,
    ShortsStreamJobsService,
    ShortsMeasurementsService,
  ],
  exports: [
    ShortsMetadataService,
    ShortsSessionsService,
    ShortsLegacyImportsService,
    ShortsStreamJobsService,
    ShortsMeasurementsService,
  ],
})
export class ShortsMetadataModule {}

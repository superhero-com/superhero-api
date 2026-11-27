import { ShortsDatabaseModule } from './shorts-database.module';
import { Module } from '@nestjs/common';
import { ShortsPublicationBoundaryService } from './shorts-publication-boundary.service';

// Runtime roles receive only the function client. Trusted provisioning uses the
// separate journal module; neither imports media decoding or signing credentials.
@Module({
  imports: [ShortsDatabaseModule],
  providers: [ShortsPublicationBoundaryService],
  exports: [ShortsPublicationBoundaryService],
})
export class ShortsPublicationBoundaryModule {}

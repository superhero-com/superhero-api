import { Module } from '@nestjs/common';
import { ShortsLegacyImportService } from './shorts-legacy-import.service';
import { ShortsNodeAccessService } from './shorts-node-access.service';

@Module({
  providers: [ShortsLegacyImportService, ShortsNodeAccessService],
  exports: [ShortsLegacyImportService],
})
export class ShortsLegacyImportModule {}

import { Module } from '@nestjs/common';
import { ShortsNativeImportService } from './shorts-native-import.service';
import { ShortsNodeAccessService } from './shorts-node-access.service';

@Module({
  providers: [ShortsNativeImportService, ShortsNodeAccessService],
  exports: [ShortsNativeImportService],
})
export class ShortsNativeImportModule {}

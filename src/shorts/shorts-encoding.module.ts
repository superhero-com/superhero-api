import { Module } from '@nestjs/common';
import { ShortsRenditionEncodingService } from './shorts-rendition-encoding.service';
import { ShortsScratchModule } from './shorts-scratch.module';
import { ShortsPackageService } from './shorts-package.service';

@Module({
  imports: [ShortsScratchModule],
  providers: [ShortsRenditionEncodingService, ShortsPackageService],
  exports: [ShortsScratchModule, ShortsRenditionEncodingService],
})
export class ShortsEncodingModule {}

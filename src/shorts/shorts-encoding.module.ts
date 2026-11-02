import { Module } from '@nestjs/common';
import { ShortsEncodingService } from './shorts-encoding.service';
import { ShortsRenditionEncodingService } from './shorts-rendition-encoding.service';
import { ShortsScratchModule } from './shorts-scratch.module';
import { ShortsPackageService } from './shorts-package.service';

@Module({
  imports: [ShortsScratchModule],
  providers: [
    ShortsEncodingService,
    ShortsRenditionEncodingService,
    ShortsPackageService,
  ],
  exports: [
    ShortsScratchModule,
    ShortsEncodingService,
    ShortsRenditionEncodingService,
  ],
})
export class ShortsEncodingModule {}

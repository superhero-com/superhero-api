import { Module } from '@nestjs/common';
import { ShortsEncodingService } from './shorts-encoding.service';
import {
  ShortsScratchService,
  ShortsScratchProbeService,
} from './shorts-scratch.service';
import {
  SHORTS_SCRATCH_CONFIG,
  shortsScratchConfig,
} from './shorts-scratch.config';

@Module({
  providers: [
    { provide: SHORTS_SCRATCH_CONFIG, useFactory: () => shortsScratchConfig() },
    ShortsScratchProbeService,
    ShortsScratchService,
    ShortsEncodingService,
  ],
  exports: [ShortsScratchService, ShortsEncodingService],
})
export class ShortsEncodingModule {}

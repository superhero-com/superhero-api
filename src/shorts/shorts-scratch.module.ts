import { Module } from '@nestjs/common';
import {
  ShortsScratchService,
  ShortsScratchProbeService,
} from './shorts-scratch.service';
import {
  SHORTS_SCRATCH_CONFIG,
  shortsScratchConfig,
} from './shorts-scratch.config';

/** Bounded file IO can be used by hosted storage without loading a decoder. */
@Module({
  providers: [
    { provide: SHORTS_SCRATCH_CONFIG, useFactory: () => shortsScratchConfig() },
    ShortsScratchProbeService,
    ShortsScratchService,
  ],
  exports: [ShortsScratchService],
})
export class ShortsScratchModule {}

import { Module } from '@nestjs/common';
import { ShortsCoreModule } from './shorts-core.module';
import { ShortsIndexService } from './shorts-index.service';
import { ShortsGateway } from './shorts.gateway';

// PostgreSQL comes from the normal API. This module is never loaded by the
// disabled feature or the standalone loopback demo.
@Module({
  imports: [ShortsCoreModule],
  providers: [ShortsIndexService, ShortsGateway],
  exports: [ShortsIndexService, ShortsGateway, ShortsCoreModule],
})
export class ShortsIndexModule {}

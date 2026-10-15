import { ShortsDatabaseModule } from './shorts-database.module';
import { Module } from '@nestjs/common';
import { ShortsCoreModule } from './shorts-core.module';
import { ShortsIndexService } from './shorts-index.service';
import { ShortsIndexNetworkService } from './shorts-index-network.service';
import { ShortsGateway } from './shorts.gateway';
import { ShortsRateModule } from './shorts-rate.module';
import {
  SHORTS_SOCKET_LIMITS,
  shortsSocketLimits,
  ShortsSocketService,
} from './shorts-socket.service';

// PostgreSQL comes from the normal API. This module is never loaded by the
// disabled feature or the standalone loopback demo.
@Module({
  imports: [ShortsDatabaseModule, ShortsCoreModule, ShortsRateModule],
  providers: [
    ShortsIndexService,
    ShortsIndexNetworkService,
    ShortsGateway,
    ShortsSocketService,
    { provide: SHORTS_SOCKET_LIMITS, useValue: shortsSocketLimits },
  ],
  exports: [ShortsIndexService, ShortsGateway, ShortsCoreModule],
})
export class ShortsIndexModule {}

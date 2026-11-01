import { Global, Module } from '@nestjs/common';
import { ShortsDatabaseService } from './shorts-database.service';

// Uses a Shorts-only token. The primary API/indexer DataSource is unchanged.
// Import only in hosted/worker/provisioning paths, never the loopback demo.
@Global()
@Module({
  providers: [ShortsDatabaseService],
  exports: [ShortsDatabaseService],
})
export class ShortsDatabaseModule {}

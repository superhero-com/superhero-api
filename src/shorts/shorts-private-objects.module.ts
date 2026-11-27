import { Module } from '@nestjs/common';
import {
  privateObjectConfig,
  SHORTS_PRIVATE_OBJECT_CONFIG,
  ShortsPrivateObjectsService,
} from './shorts-private-objects.service';

// Opt-in worker/API storage dependency. No chain signer, IPFS publishing key or
// local SQLite store is imported here. Configuration never creates a bucket.
@Module({
  providers: [
    {
      provide: SHORTS_PRIVATE_OBJECT_CONFIG,
      useFactory: () => privateObjectConfig(),
    },
    ShortsPrivateObjectsService,
  ],
  exports: [ShortsPrivateObjectsService],
})
export class ShortsPrivateObjectsModule {}

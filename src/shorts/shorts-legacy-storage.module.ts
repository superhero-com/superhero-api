import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsStoreService, SHORTS_DATA_DIR } from './shorts-store.service';
import { realpath } from 'node:fs/promises';
import { ShortsSharedUploadsModule } from './shorts-shared-uploads.module';
import { ShortsMetadataModule } from './shorts-metadata.module';
import { ShortsPackageService } from './shorts-package.service';
import { ShortsReceiptsService } from './shorts-receipts.service';
import {
  LegacyStorageConfig,
  legacyStorageConfig,
  SHORTS_LEGACY_STORAGE_CONFIG,
  ShortsLegacyStorageService,
} from './shorts-legacy-storage.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...DATABASE_CONFIG,
      synchronize: false,
      autoLoadEntities: false,
      extra: {
        ...DATABASE_CONFIG.extra,
        statement_timeout: 15000,
        lock_timeout: 10000,
      },
    }),
    ShortsSharedUploadsModule,
    ShortsMetadataModule,
  ],
  providers: [
    {
      provide: SHORTS_LEGACY_STORAGE_CONFIG,
      useFactory: () => legacyStorageConfig(),
    },
    {
      provide: ShortsStoreService,
      inject: [SHORTS_LEGACY_STORAGE_CONFIG],
      useFactory: async (config: LegacyStorageConfig) => {
        if ((await realpath(SHORTS_DATA_DIR)) !== config.directory)
          throw new Error(
            'Legacy storage configuration changed during startup',
          );
        return new ShortsStoreService();
      },
    },
    ShortsPackageService,
    ShortsReceiptsService,
    ShortsLegacyStorageService,
  ],
})
export class ShortsLegacyStorageModule {}

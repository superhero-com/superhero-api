import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsDatabaseModule } from './shorts-database.module';
import { SHORTS_RETENTION_CONFIG } from './shorts-retention.config';
import { ShortsRetentionService } from './shorts-retention.service';
import {
  SHORTS_PRIVATE_OBJECT_CONFIG,
  ShortsPrivateObjectsService,
} from './shorts-private-objects.service';
import { ShortsSourceReaderService } from './shorts-source-reader.service';
import {
  SHORTS_STORAGE_RECONCILIATION_CONFIG,
  StorageReconciliationConfig,
  storageReconciliationConfig,
} from './shorts-storage-reconciliation.config';
import { ShortsStorageReconciliationService } from './shorts-storage-reconciliation.service';

// Operations-only process: no public API, media workers or publication credentials.
@Module({
  imports: [
    ShortsDatabaseModule,
    TypeOrmModule.forRoot({
      ...DATABASE_CONFIG,
      synchronize: false,
      autoLoadEntities: false,
      logging: false,
      retryAttempts: 0,
      extra: { max: 1, connectionTimeoutMillis: 1000 },
    }),
  ],
  providers: [
    {
      provide: SHORTS_STORAGE_RECONCILIATION_CONFIG,
      useFactory: () => storageReconciliationConfig(),
    },
    {
      provide: SHORTS_RETENTION_CONFIG,
      useExisting: SHORTS_STORAGE_RECONCILIATION_CONFIG,
    },
    {
      provide: SHORTS_PRIVATE_OBJECT_CONFIG,
      inject: [SHORTS_STORAGE_RECONCILIATION_CONFIG],
      useFactory: (config: StorageReconciliationConfig) => config.objects,
    },
    ShortsPrivateObjectsService,
    ShortsSourceReaderService,
    ShortsRetentionService,
    ShortsStorageReconciliationService,
  ],
})
export class ShortsStorageReconciliationModule {}

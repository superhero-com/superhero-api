import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsDatabaseModule } from './shorts-database.module';
import {
  SHORTS_PRIVATE_OBJECT_CONFIG,
  ShortsPrivateObjectsService,
} from './shorts-private-objects.service';
import {
  SHORTS_STORAGE_RECONCILIATION_CONFIG,
  StorageReconciliationConfig,
  storageReconciliationConfig,
} from './shorts-storage-reconciliation.config';
import { ShortsPrivateVersionStorageService } from './shorts-private-version-storage.service';
import { ShortsPrivateInputVersionStorageService } from './shorts-private-input-version-storage.service';
import { ShortsPrivateInputCleanupJournalService } from './shorts-private-input-cleanup-journal.service';
import { ShortsPrivateInputCleanupClientService } from './shorts-private-input-cleanup-client.service';
import { ShortsPrivateInputCleanupService } from './shorts-private-input-cleanup.service';

// Separate process: no public listener, scheduler, media or publication modules.
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
      provide: SHORTS_PRIVATE_OBJECT_CONFIG,
      inject: [SHORTS_STORAGE_RECONCILIATION_CONFIG],
      useFactory: (config: StorageReconciliationConfig) => config.objects,
    },
    ShortsPrivateObjectsService,
    ShortsPrivateVersionStorageService,
    ShortsPrivateInputVersionStorageService,
    ShortsPrivateInputCleanupJournalService,
    ShortsPrivateInputCleanupClientService,
    ShortsPrivateInputCleanupService,
  ],
})
export class ShortsPrivateInputCleanupModule {}

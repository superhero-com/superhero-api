import { ShortsDatabaseModule } from './shorts-database.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsPrivateObjectsModule } from './shorts-private-objects.module';
import { ShortsSourceReaderService } from './shorts-source-reader.service';
import { ShortsEncodingModule } from './shorts-encoding.module';
import { ShortsPackageService } from './shorts-package.service';
import { ShortsSafetyService } from './shorts-safety.service';
import { ShortsLabelsService } from './shorts-labels.service';
import { ShortsMediaWorkerService } from './shorts-media-worker.service';
import { ShortsWorkerRepositoryService } from './shorts-worker-repository.service';

import {
  SHORTS_WORKER_CONFIG,
  shortsWorkerConfig,
} from './shorts-worker.config';

@Module({
  imports: [
    ShortsDatabaseModule,
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
    ShortsPrivateObjectsModule,
    ShortsEncodingModule,
  ],
  providers: [
    { provide: SHORTS_WORKER_CONFIG, useFactory: () => shortsWorkerConfig() },
    ShortsPackageService,
    ShortsSafetyService,
    ShortsLabelsService,
    ShortsMediaWorkerService,
    ShortsWorkerRepositoryService,
    ShortsSourceReaderService,
  ],
})
export class ShortsWorkerModule {}

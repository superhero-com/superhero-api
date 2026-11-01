import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsDatabaseModule } from './shorts-database.module';
import { SHORTS_RETENTION_CONFIG } from './shorts-retention.config';
import { ShortsRetentionService } from './shorts-retention.service';
import { ShortsHlsIndexReaderService } from './shorts-hls-index-reader.service';
import {
  SHORTS_HLS_INVENTORY_CONFIG,
  hlsInventoryConfig,
} from './shorts-hls-inventory.config';
import { ShortsHlsInventoryService } from './shorts-hls-inventory.service';

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
      provide: SHORTS_HLS_INVENTORY_CONFIG,
      useFactory: () => hlsInventoryConfig(),
    },
    {
      provide: SHORTS_RETENTION_CONFIG,
      useExisting: SHORTS_HLS_INVENTORY_CONFIG,
    },
    ShortsHlsIndexReaderService,
    ShortsRetentionService,
    ShortsHlsInventoryService,
  ],
})
export class ShortsHlsInventoryModule {}

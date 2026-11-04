import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsDatabaseModule } from './shorts-database.module';
import { SHORTS_RETENTION_CONFIG } from './shorts-retention.config';
import { ShortsRetentionService } from './shorts-retention.service';
import { ShortsPinReaderService } from './shorts-pin-reader.service';
import {
  SHORTS_PIN_INVENTORY_CONFIG,
  pinInventoryConfig,
} from './shorts-pin-inventory.config';
import { ShortsPinInventoryService } from './shorts-pin-inventory.service';

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
      provide: SHORTS_PIN_INVENTORY_CONFIG,
      useFactory: () => pinInventoryConfig(),
    },
    {
      provide: SHORTS_RETENTION_CONFIG,
      useExisting: SHORTS_PIN_INVENTORY_CONFIG,
    },
    ShortsPinReaderService,
    ShortsRetentionService,
    ShortsPinInventoryService,
  ],
})
export class ShortsPinInventoryModule {}

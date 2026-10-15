import { Module } from '@nestjs/common';
import { ShortsMultipartInventoryService } from './shorts-multipart-inventory.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsDatabaseModule } from './shorts-database.module';
import {
  SHORTS_STORAGE_INVENTORY_CONFIG,
  storageInventoryConfig,
} from './shorts-storage-inventory.config';
import { ShortsStorageListService } from './shorts-storage-list.service';
import { ShortsStorageInventoryService } from './shorts-storage-inventory.service';

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
      provide: SHORTS_STORAGE_INVENTORY_CONFIG,
      useFactory: () => storageInventoryConfig(),
    },
    ShortsStorageListService,
    ShortsStorageInventoryService,
    ShortsMultipartInventoryService,
  ],
})
export class ShortsStorageInventoryModule {}

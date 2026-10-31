import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsDatabaseModule } from './shorts-database.module';
import {
  retentionConfig,
  SHORTS_RETENTION_CONFIG,
} from './shorts-retention.config';
import { ShortsRetentionService } from './shorts-retention.service';

// An explicit operations entrypoint; never imported by the public API or workers.
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
    { provide: SHORTS_RETENTION_CONFIG, useFactory: () => retentionConfig() },
    ShortsRetentionService,
  ],
})
export class ShortsRetentionModule {}

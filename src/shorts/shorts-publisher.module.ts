import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsPublicationBoundaryModule } from './shorts-publication-boundary.module';
import {
  SHORTS_PUBLISHER_CONFIG,
  shortsPublisherConfig,
} from './shorts-publisher.config';
import { ShortsPublisherNodeService } from './shorts-publisher-node.service';
import { ShortsPublisherService } from './shorts-publisher.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...DATABASE_CONFIG,
      synchronize: false,
      autoLoadEntities: false,
      logging: false,
      extra: {
        ...DATABASE_CONFIG.extra,
        max: 3,
        min: 0,
        statement_timeout: 15000,
        lock_timeout: 5000,
      },
    }),
    ShortsPublicationBoundaryModule,
  ],
  providers: [
    {
      provide: SHORTS_PUBLISHER_CONFIG,
      useFactory: () => shortsPublisherConfig(),
    },
    ShortsPublisherNodeService,
    ShortsPublisherService,
  ],
})
export class ShortsPublisherModule {}

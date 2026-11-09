import { ShortsDatabaseModule } from './shorts-database.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsMetadataService } from './shorts-metadata.service';
import { ShortsPublicationsService } from './shorts-publications.service';
import { ShortsPublisherSetupService } from './shorts-publisher-setup.service';

@Module({
  imports: [
    ShortsDatabaseModule,
    TypeOrmModule.forRoot({
      ...DATABASE_CONFIG,
      synchronize: false,
      autoLoadEntities: false,
      logging: false,
    }),
  ],
  providers: [
    ShortsMetadataService,
    ShortsPublicationsService,
    ShortsPublisherSetupService,
  ],
})
export class ShortsPublisherSetupModule {}

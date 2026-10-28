import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DATABASE_CONFIG } from '../configs/database';
import { ShortsDatabaseModule } from './shorts-database.module';
import { ShortsLikeSponsorSetupService } from './shorts-like-sponsor-setup.service';

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
  providers: [ShortsLikeSponsorSetupService],
})
export class ShortsLikeSponsorSetupModule {}

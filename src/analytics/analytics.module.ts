import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Keyv } from 'keyv';
import { createLruKeyvStore } from '@/utils/lru-keyv-store';
import { Analytic } from './entities/analytic.entity';
import { AnalyticController } from './controllers/analytic.controller';
import { TokensModule } from '@/tokens/tokens.module';
import { AeModule } from '@/ae/ae.module';
import { TransactionsModule } from '@/transactions/transactions.module';
import { CacheDailyAnalyticsDataService } from './services/cache-daily-analytics-data.service';
import { ChallengeAnalyticsService } from './services/challenge-analytics.service';
import { ChallengeAnalyticsController } from './controllers/challenge-analytics.controller';
import { AccountModule } from '@/account/account.module';
import { Post } from '@/social/entities/post.entity';

@Module({
  imports: [
    // The global store loses every write with a TTL, and fixing it would switch
    // on all other cached endpoints at once, so this module has its own.
    CacheModule.registerAsync({
      useFactory: () => ({
        stores: [
          new Keyv({
            store: createLruKeyvStore({
              max: 1000,
              maxSize: 16 * 1024 * 1024,
            }),
          }),
        ],
      }),
    }),
    AeModule,
    TokensModule,
    TransactionsModule,
    AccountModule,
    TypeOrmModule.forFeature([Analytic, Post]),
  ],
  providers: [CacheDailyAnalyticsDataService, ChallengeAnalyticsService],
  exports: [],
  controllers: [
    // Register ChallengeAnalyticsController BEFORE AnalyticController so that
    // /analytics/challenge* routes are matched before any future
    // /analytics/:something path registered on AnalyticController.
    ChallengeAnalyticsController,
    AnalyticController,
  ],
})
export class AnalyticsModule {
  //
}

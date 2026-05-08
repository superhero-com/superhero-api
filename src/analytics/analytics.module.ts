import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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

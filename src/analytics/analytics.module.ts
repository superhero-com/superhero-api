import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Analytic } from './entities/analytic.entity';
import { AnalyticController } from './controllers/analytic.controller';
import { TokensModule } from '@/plugins/bcl/tokens.module';
import { AeModule } from '@/ae/ae.module';
import { TransactionsModule } from '@/plugins/bcl/transactions.module';
import { CacheDailyAnalyticsDataService } from './services/cache-daily-analytics-data.service';

@Module({
  imports: [
    AeModule,
    TokensModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Analytic]),
  ],
  providers: [CacheDailyAnalyticsDataService],
  exports: [],
  controllers: [AnalyticController],
})
export class AnalyticsModule {
  //
}

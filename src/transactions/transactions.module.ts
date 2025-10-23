import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { AeModule } from '@/ae/ae.module';
import { SYNC_TOKEN_HOLDERS_QUEUE } from '@/tokens/queues/constants';
import { TokensModule } from '@/tokens/tokens.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsTransactionsController } from './controllers/analytics-transactions.controller';
import { HistoricalController } from './controllers/historical.controller';
import { TokenPerformanceController } from './controllers/token-performance.controller';
import { TransactionsController } from './controllers/transactions.controller';
import { Transaction } from './entities/transaction.entity';
import { TokenPerformance } from './entities/token-performance.entity';
import { TransactionHistoryService } from './services/transaction-history.service';
import { TransactionService } from './services/transaction.service';
import { TokenPerformanceService } from './services/token-performance.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, TokenPerformance]),
    BullModule.registerQueue({
      name: SYNC_TOKEN_HOLDERS_QUEUE,
    }),
    AeModule,
    TokensModule,
    AePricingModule,
  ],
  providers: [
    TransactionService,
    TransactionHistoryService,
    TokenPerformanceService,
  ],
  exports: [TypeOrmModule, TransactionService, TokenPerformanceService],
  controllers: [
    TransactionsController,
    HistoricalController,
    TokenPerformanceController,
    AnalyticsTransactionsController,
  ],
})
export class TransactionsModule {
  //
}

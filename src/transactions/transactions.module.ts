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
import {
  SYNC_TRANSACTIONS_QUEUE,
  VALIDATE_TOKEN_TRANSACTIONS_QUEUE,
  VALIDATE_TRANSACTIONS_QUEUE,
} from './queues/constants';
import { SyncTransactionsQueue } from './queues/sync-transactions.queue';
import { ValidateTokenTransactionsQueue } from './queues/validate-token-transactions.queue';
import { ValidateTransactionsQueue } from './queues/validate-transactions.queue';
import { TransactionHistoryService } from './services/transaction-history.service';
import { TransactionService } from './services/transaction.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction]),
    BullModule.registerQueue(
      {
        name: SYNC_TRANSACTIONS_QUEUE,
      },
      {
        name: SYNC_TOKEN_HOLDERS_QUEUE,
      },
      {
        name: VALIDATE_TRANSACTIONS_QUEUE,
      },
      {
        name: VALIDATE_TOKEN_TRANSACTIONS_QUEUE,
      },
    ),
    AeModule,
    TokensModule,
    AePricingModule,
  ],
  providers: [
    TransactionService,
    TransactionHistoryService,
    SyncTransactionsQueue,
    ValidateTransactionsQueue,
    ValidateTokenTransactionsQueue,
  ],
  exports: [TypeOrmModule, TransactionService],
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

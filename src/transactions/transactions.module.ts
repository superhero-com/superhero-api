import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AePricingModule } from 'src/ae-pricing/ae-pricing.module';
import { AeModule } from 'src/ae/ae.module';
import {
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from 'src/tokens/queues/constants';
import { TokensModule } from 'src/tokens/tokens.module';
import { HistoricalController } from './controllers/historical.controller';
import { TokenPerformanceController } from './controllers/token-performance.controller';
import { TransactionsController } from './controllers/transactions.controller';
import { Transaction } from './entities/transaction.entity';
import {
  SAVE_TRANSACTION_QUEUE,
  SYNC_TRANSACTIONS_QUEUE,
  VALIDATE_TOKEN_TRANSACTIONS_QUEUE,
  VALIDATE_TRANSACTIONS_QUEUE,
} from './queues/constants';
import { SaveTransactionQueue } from './queues/save-transaction.queue';
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
        name: SAVE_TRANSACTION_QUEUE,
      },
      {
        name: SYNC_TRANSACTIONS_QUEUE,
      },
      {
        name: SYNC_TOKEN_HOLDERS_QUEUE,
      },
      {
        name: SYNC_TOKENS_RANKS_QUEUE,
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
    SaveTransactionQueue,
    SyncTransactionsQueue,
    ValidateTransactionsQueue,
    ValidateTokenTransactionsQueue,
  ],
  exports: [TypeOrmModule],
  controllers: [
    TransactionsController,
    HistoricalController,
    TokenPerformanceController,
  ],
})
export class TransactionsModule {
  //
}

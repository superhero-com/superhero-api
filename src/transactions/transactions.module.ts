import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from 'src/ae/ae.module';
import { TokensModule } from 'src/tokens/tokens.module';
import { SaveTransactionQueue } from './queues/save-transaction.queue';
import { Transaction } from './entities/transaction.entity';
import { TransactionService } from './services/transaction.service';
import {
  SAVE_TRANSACTION_QUEUE,
  SYNC_TRANSACTIONS_QUEUE,
} from './queues/constants';
import { SyncTransactionsQueue } from './queues/sync-transactions.queue';
import { TransactionsController } from './controllers/transactions.controller';
import { HistoricalController } from './controllers/historical.controller';
import { TransactionHistoryService } from './services/transaction-history.service';

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
    ),
    AeModule,
    TokensModule,
  ],
  providers: [
    TransactionService,
    TransactionHistoryService,
    SaveTransactionQueue,
    SyncTransactionsQueue,
  ],
  exports: [TypeOrmModule],
  controllers: [TransactionsController, HistoricalController],
})
export class TransactionsModule {
  //
}

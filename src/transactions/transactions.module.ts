import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from 'src/ae/ae.module';
import { SAVE_TRANSACTION_QUEUE } from 'src/token-sale/queues';
import { TokensModule } from 'src/tokens/tokens.module';
import { SaveTransactionQueue } from './queues/save-transaction.queue';
import { Transaction } from './entities/transaction.entity';
import { TransactionService } from './transaction.service';
import { SYNC_TRANSACTIONS_QUEUE } from './queues/constants';
import { SyncTransactionsQueue } from './queues/sync-transactions.queue';

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
  providers: [TransactionService, SaveTransactionQueue, SyncTransactionsQueue],
  exports: [TypeOrmModule],
})
export class TransactionsModule {
  //
}

import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from 'src/ae/ae.module';
import { SAVE_TRANSACTION_QUEUE } from 'src/token-sale/queues';
import { TokensModule } from 'src/tokens/tokens.module';
import { SaveTransactionQueue } from './save-transaction.queue';
import { Transaction } from './entities/transaction.entity';
import { TransactionService } from './transaction.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction]),
    BullModule.registerQueue({
      name: SAVE_TRANSACTION_QUEUE,
    }),
    AeModule,
    TokensModule,
  ],
  providers: [TransactionService, SaveTransactionQueue],
  exports: [TypeOrmModule],
})
export class TransactionsModule {
  //
}

import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { AeModule } from '@/ae/ae.module';
import { TokensModule } from '@/plugins/bcl/tokens.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsTransactionsController } from './controllers/analytics-transactions.controller';
import { HistoricalController } from './controllers/historical.controller';
import { TransactionsController } from './controllers/transactions.controller';
import { Transaction } from './entities/transaction.entity';
import { TransactionHistoryService } from './services/transaction-history.service';
import { TransactionService } from './services/transaction.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction]),
    AeModule,
    TokensModule,
    AePricingModule,
  ],
  providers: [TransactionService, TransactionHistoryService],
  exports: [TypeOrmModule, TransactionService],
  controllers: [
    TransactionsController,
    HistoricalController,
    AnalyticsTransactionsController,
  ],
})
export class TransactionsModule {
  //
}

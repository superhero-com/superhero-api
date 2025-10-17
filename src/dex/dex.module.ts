import { AeModule } from '@/ae/ae.module';
import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { TransactionsModule } from '@/transactions/transactions.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DexTokensController } from './controllers/dex-tokens.controller';
import { PairsController } from './controllers/pairs.controller';
import { PairTransactionsController } from './controllers/pair-transactions.controller';
import { DexToken } from './entities/dex-token.entity';
import { Pair } from './entities/pair.entity';
import { PairTransaction } from './entities/pair-transaction.entity';
import { DexSyncService } from './services/dex-sync.service';
import { DexTokenService } from './services/dex-token.service';
import { PairService } from './services/pair.service';
import { PairTransactionService } from './services/pair-transaction.service';
import { PairHistoryService } from './services/pair-history.service';

@Module({
  imports: [
    AeModule,
    AePricingModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Pair, DexToken, PairTransaction]),
  ],
  providers: [
    PairService,
    DexTokenService,
    PairTransactionService,
    DexSyncService,
    PairHistoryService,
  ],
  exports: [
    PairService,
    DexTokenService,
    PairTransactionService,
    DexSyncService,
  ],
  controllers: [
    PairsController,
    DexTokensController,
    PairTransactionsController,
  ],
})
export class DexModule {
  //
}

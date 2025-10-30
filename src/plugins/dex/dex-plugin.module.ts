import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { AeModule } from '@/ae/ae.module';
import { MDW_PLUGIN } from '@/mdw-sync/plugins/plugin.tokens';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DexTokensController } from './controllers/dex-tokens.controller';
import { PairTransactionsController } from './controllers/pair-transactions.controller';
import { PairsController } from './controllers/pairs.controller';
import { DexPlugin } from './dex.plugin';
import { DexTokenSummary } from './entities/dex-token-summary.entity';
import { DexToken } from './entities/dex-token.entity';
import { PairSummary } from './entities/pair-summary.entity';
import { PairTransaction } from './entities/pair-transaction.entity';
import { Pair } from './entities/pair.entity';
import { DexSyncService } from './services/dex-sync.service';
import { DexTokenSummaryService } from './services/dex-token-summary.service';
import { DexTokenService } from './services/dex-token.service';
import { PairHistoryService } from './services/pair-history.service';
import { PairSummaryService } from './services/pair-summary.service';
import { PairTransactionService } from './services/pair-transaction.service';
import { PairService } from './services/pair.service';
import { TxSubscriber } from './subscribers/tx.subscriber';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Pair,
      DexToken,
      PairTransaction,
      PairSummary,
      DexTokenSummary,
    ]),
    AeModule,
    AePricingModule,
  ],
  controllers: [
    DexTokensController,
    PairsController,
    PairTransactionsController,
  ],
  providers: [
    DexPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: DexPlugin,
    },
    // Subscribers
    TxSubscriber,
    // Ensure DI for Dex dependencies not exported by DexModule
    PairHistoryService,
    PairService,
    DexTokenService,
    PairTransactionService,
    DexSyncService,
    PairHistoryService,
    PairSummaryService,
    DexTokenSummaryService,
  ],
  exports: [DexPlugin],
})
export class DexPluginModule {}

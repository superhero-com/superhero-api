import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DexPlugin } from './dex.plugin';
import { DexTokensController } from './controllers/dex-tokens.controller';
import { PairsController } from './controllers/pairs.controller';
import { PairTransactionsController } from './controllers/pair-transactions.controller';
import { DexToken } from './entities/dex-token.entity';
import { Pair } from './entities/pair.entity';
import { PairTransaction } from './entities/pair-transaction.entity';
import { DexModule } from '@/dex/dex.module';
import { AeModule } from '@/ae/ae.module';
import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { MDW_PLUGIN } from '@/mdw/plugins/plugin.tokens';
import { PairHistoryService } from './services/pair-history.service';
import { PairSummary } from './entities/pair-summary.entity';
import { DexTokenSummary } from './entities/dex-token-summary.entity';
import { PairService } from './services/pair.service';
import { DexTokenService } from './services/dex-token.service';
import { PairTransactionService } from './services/pair-transaction.service';
import { DexSyncService } from './services/dex-sync.service';
import { PairSummaryService } from './services/pair-summary.service';
import { DexTokenSummaryService } from './services/dex-token-summary.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Pair,
      DexToken,
      PairTransaction,
      PairSummary,
      DexTokenSummary,
    ]),
    DexModule,
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
export class DexPluginModule { }

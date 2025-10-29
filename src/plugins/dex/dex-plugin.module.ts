import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DexPlugin } from './dex.plugin';
import { DexTokensController } from './controllers/dex-tokens.controller';
import { PairsController } from './controllers/pairs.controller';
import { PairTransactionsController } from './controllers/pair-transactions.controller';
import { DexToken } from '@/dex/entities/dex-token.entity';
import { Pair } from '@/dex/entities/pair.entity';
import { PairTransaction } from '@/dex/entities/pair-transaction.entity';
import { DexModule } from '@/dex/dex.module';
import { AeModule } from '@/ae/ae.module';
import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { MDW_PLUGIN } from '@/mdw/plugins/plugin.tokens';
import { PairHistoryService } from '@/dex/services/pair-history.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DexToken, Pair, PairTransaction]),
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
  ],
  exports: [DexPlugin],
})
export class DexPluginModule {}

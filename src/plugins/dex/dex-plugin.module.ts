import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DexPlugin } from './dex.plugin';
import { DexToken } from '@/dex/entities/dex-token.entity';
import { Pair } from '@/dex/entities/pair.entity';
import { PairTransaction } from '@/dex/entities/pair-transaction.entity';
import { DexModule } from '@/dex/dex.module';
import { AeModule } from '@/ae/ae.module';
import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { MDW_PLUGIN } from '@/mdw/plugins/plugin.tokens';

@Module({
  imports: [
    TypeOrmModule.forFeature([DexToken, Pair, PairTransaction]),
    DexModule,
    AeModule,
    AePricingModule,
  ],
  providers: [
    DexPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: DexPlugin,
    },
  ],
  exports: [DexPlugin],
})
export class DexPluginModule {}

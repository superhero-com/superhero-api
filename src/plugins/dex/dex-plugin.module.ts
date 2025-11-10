import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { AeModule } from '@/ae/ae.module';
import { DexModule } from '@/dex/dex.module';
import { DexToken } from '@/dex/entities/dex-token.entity';
import { Pair } from '@/dex/entities/pair.entity';
import { PairTransaction } from '@/dex/entities/pair-transaction.entity';
import { DexPlugin } from './dex.plugin';
import { DexPluginSyncService } from './dex-plugin-sync.service';
import { DexTransactionProcessorService } from './services/dex-transaction-processor.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tx, PluginSyncState, DexToken, Pair, PairTransaction]),
    AeModule,
    DexModule,
  ],
  providers: [
    DexTransactionProcessorService,
    DexPluginSyncService,
    DexPlugin,
  ],
  exports: [DexPlugin],
})
export class DexPluginModule {}




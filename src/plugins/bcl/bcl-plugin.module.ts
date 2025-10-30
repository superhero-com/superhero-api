import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { MDW_PLUGIN } from '@/mdw-sync/plugins/plugin.tokens';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { BclPlugin } from './bcl.plugin';
import { BclTxListener } from './listeners/bcl-tx.listener';
import { BclSyncTransactionService } from './services/bcl-sync-transaction.service';
import { TokensModule } from './tokens.module';
import { TransactionsModule } from './transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tx, PluginSyncState]),
    AeModule,
    TokensModule,
    TransactionsModule,
  ],
  providers: [
    BclPlugin,
    {
      provide: MDW_PLUGIN,
      useClass: BclPlugin,
    },
    BclTxListener,
    BclSyncTransactionService,
  ],
  exports: [BclPlugin],
})
export class BclPluginModule {}

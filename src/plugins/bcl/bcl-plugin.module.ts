import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { TransactionsModule } from '@/transactions/transactions.module';
import { TokensModule } from '@/tokens/tokens.module';
import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { AeModule } from '@/ae/ae.module';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { BclPlugin } from './bcl.plugin';
import { BclPluginSyncService } from './bcl-plugin-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tx, PluginSyncState, Transaction]),
    TransactionsModule,
    TokensModule,
    AePricingModule,
    AeModule,
  ],
  providers: [BclPluginSyncService, BclPlugin],
  exports: [BclPlugin],
})
export class BclPluginModule {}


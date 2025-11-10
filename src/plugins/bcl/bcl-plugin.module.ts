import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { TransactionsModule } from '@/transactions/transactions.module';
import { TokensModule } from '@/tokens/tokens.module';
import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { AeModule } from '@/ae/ae.module';
import { BullModule } from '@nestjs/bull';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { PULL_TOKEN_INFO_QUEUE } from '@/tokens/queues/constants';
import { BclPlugin } from './bcl.plugin';
import { BclPluginSyncService } from './services/bcl-plugin-sync.service';
import { TransactionsService } from './services/transactions.service';
import { TokenService } from './services/token.service';
import { TransactionValidationService } from './services/transaction-validation.service';
import { TransactionDataService } from './services/transaction-data.service';
import { TransactionPersistenceService } from './services/transaction-persistence.service';
import { TransactionProcessorService } from './services/transaction-processor.service';
import { TokenHolderService } from './services/token-holder.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Tx, PluginSyncState, Transaction, TokenHolder, Token]),
    TransactionsModule,
    TokensModule,
    AePricingModule,
    AeModule,
    BullModule.registerQueue({
      name: PULL_TOKEN_INFO_QUEUE,
    }),
  ],
  providers: [
    TransactionValidationService,
    TransactionDataService,
    TransactionPersistenceService,
    TransactionsService,
    TokenService,
    TokenHolderService,
    TransactionProcessorService,
    BclPluginSyncService,
    BclPlugin,
  ],
  exports: [BclPlugin],
})
export class BclPluginModule {}


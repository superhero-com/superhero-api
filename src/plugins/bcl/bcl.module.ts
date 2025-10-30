import { AeModule } from '@/ae/ae.module';
import { TokensModule } from '@/plugins/bcl/tokens.module';
import { TransactionsModule } from '@/plugins/bcl/transactions.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DebugFailedTransactionsController } from './controllers/debug-failed-transactions.controller';
import { FailedTransaction } from './entities/failed-transaction.entity';
import { SyncedBlock } from './entities/synced-block.entity';

/**
 * @deprecated
 */
@Module({
  imports: [
    AeModule,
    TokensModule,
    TransactionsModule,
    TypeOrmModule.forFeature([SyncedBlock, FailedTransaction]),

    // PostModule,
    // DexModule,
    // TipModule,
  ],
  providers: [
    // SyncTransactionsService,
    // SyncBlocksService,
    // FixFailedTransactionsService,
    // FixTokensService,
    // FastPullTokensService,
    // FixHoldersService,
    // VerifyTransactionsService,
  ],
  // exports: [SyncBlocksService, SyncTransactionsService],
  controllers: [DebugFailedTransactionsController],
})
export class BclModule {
  //
}

import { AeModule } from '@/ae/ae.module';
import {
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
} from '@/tokens/queues/constants';
import { TokensModule } from '@/tokens/tokens.module';
import { TransactionsModule } from '@/transactions/transactions.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DebugFailedTransactionsController } from './controllers/debug-failed-transactions.controller';
import { FailedTransaction } from './entities/failed-transaction.entity';
import { SyncedBlock } from './entities/synced-block.entity';
import { SyncBlocksService } from './services/sync-blocks.service';
import { SyncTransactionsService } from './services/sync-transactions.service';

/**
 * @deprecated
 */
@Module({
  imports: [
    AeModule,
    TokensModule,
    TransactionsModule,
    TypeOrmModule.forFeature([SyncedBlock, FailedTransaction]),
    BullModule.registerQueue(
      {
        name: SYNC_TOKEN_HOLDERS_QUEUE,
      },
      {
        name: PULL_TOKEN_INFO_QUEUE,
      },
    ),
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

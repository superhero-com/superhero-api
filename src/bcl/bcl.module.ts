import { AeModule } from '@/ae/ae.module';
import { SYNC_TOKEN_HOLDERS_QUEUE } from '@/tokens/queues/constants';
import { TokensModule } from '@/tokens/tokens.module';
import { TransactionsModule } from '@/transactions/transactions.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DebugFailedTransactionsController } from './controllers/debug-failed-transactions.controller';
import { FailedTransaction } from './entities/failed-transaction.entity';
import { SyncedBlock } from './entities/synced-block.entity';
import { FastPullTokensService } from './services/fast-pull-tokens.service';
import { FixFailedTransactionsService } from './services/fix-failed-transactions.service';
import { FixHoldersService } from './services/fix-holders.service';
import { FixTokensService } from './services/fix-tokens.service';
import { SyncBlocksService } from './services/sync-blocks.service';
import { SyncTransactionsService } from './services/sync-transactions.service';
import { VerifyTransactionsService } from './services/verify-transactions.service';

@Module({
  imports: [
    AeModule,
    TokensModule,
    TransactionsModule,
    TypeOrmModule.forFeature([SyncedBlock, FailedTransaction]),
    BullModule.registerQueue({
      name: SYNC_TOKEN_HOLDERS_QUEUE,
    }),
  ],
  providers: [
    SyncTransactionsService,
    SyncBlocksService,
    FixFailedTransactionsService,
    FixTokensService,
    FastPullTokensService,
    FixHoldersService,
    VerifyTransactionsService,
  ],
  exports: [SyncBlocksService],
  controllers: [DebugFailedTransactionsController],
})
export class BclModule {
  //
}

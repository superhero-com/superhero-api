import { AeModule } from '@/ae/ae.module';
import { DexModule } from '@/dex/dex.module';
import { PostModule } from '@/social/post.module';
import { TipModule } from '@/tipping/tip.module';
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
import { FastPullTokensService } from './services/fast-pull-tokens.service';
import { FixFailedTransactionsService } from './services/fix-failed-transactions.service';
import { FixHoldersService } from './services/fix-holders.service';
import { FixTokensService } from './services/fix-tokens.service';
import { SyncState } from '@/mdw-sync/entities/sync-state.entity';

@Module({
  imports: [
    AeModule,
    TokensModule,
    TransactionsModule,
    TypeOrmModule.forFeature([SyncedBlock, FailedTransaction, SyncState]),
    BullModule.registerQueue(
      {
        name: SYNC_TOKEN_HOLDERS_QUEUE,
      },
      {
        name: PULL_TOKEN_INFO_QUEUE,
      },
    ),
    PostModule,
    DexModule,
    TipModule,
  ],
  providers: [
    FixFailedTransactionsService,
    FixTokensService,
    FastPullTokensService,
    FixHoldersService,
  ],
  exports: [],
  controllers: [DebugFailedTransactionsController],
})
export class BclModule {
  //
}

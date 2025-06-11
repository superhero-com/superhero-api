import { AeModule } from '@/ae/ae.module';
import { TokensModule } from '@/tokens/tokens.module';
import { TransactionsModule } from '@/transactions/transactions.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FailedTransaction } from './entities/failed-transaction.entity';
import { SyncedBlock } from './entities/synced-block.entity';
import { FixFailedTransactionsService } from './services/fix-failed-transactions.service';
import { SyncBlocksService } from './services/sync-blocks.service';
import { SyncTransactionsService } from './services/sync-transactions.service';
import { DebugFailedTransactionsController } from './controllers/debug-failed-transactions.controller';

@Module({
  imports: [
    AeModule,
    TokensModule,
    TransactionsModule,
    TypeOrmModule.forFeature([SyncedBlock, FailedTransaction]),
  ],
  providers: [
    SyncTransactionsService,
    SyncBlocksService,
    FixFailedTransactionsService,
  ],
  exports: [SyncBlocksService],
  controllers: [DebugFailedTransactionsController],
})
export class BclModule {
  //
}

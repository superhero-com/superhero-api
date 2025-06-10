import { AeModule } from '@/ae/ae.module';
import { TokensModule } from '@/tokens/tokens.module';
import { TransactionsModule } from '@/transactions/transactions.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FailedTransaction } from './entities/failed-transaction.entity';
import { SyncedBlock } from './entities/synced-block.entity';
import { SyncBlocksService } from './sync-blocks.service';
import { SyncTransactionsService } from './sync-transactions.service';

@Module({
  imports: [
    AeModule,
    TokensModule,
    TransactionsModule,
    TypeOrmModule.forFeature([SyncedBlock, FailedTransaction]),
  ],
  providers: [SyncTransactionsService, SyncBlocksService],
  exports: [SyncBlocksService],
})
export class BclModule {
  //
}

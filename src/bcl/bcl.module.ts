import { AeModule } from '@/ae/ae.module';
import { TokensModule } from '@/tokens/tokens.module';
import { Module } from '@nestjs/common';
import { SyncTransactionsService } from './sync-transactions.service';
import { TransactionsModule } from '@/transactions/transactions.module';

@Module({
  imports: [AeModule, TokensModule, TransactionsModule],
  providers: [SyncTransactionsService],
})
export class BclModule {
  //
}

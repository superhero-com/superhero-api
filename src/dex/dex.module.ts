import { AeModule } from '@/ae/ae.module';
import { TransactionsModule } from '@/transactions/transactions.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DexTokensController } from './controllers/dex-tokens.controller';
import { PairsController } from './controllers/pairs.controller';
import { DexToken } from './entities/dex-token.entity';
import { Pair } from './entities/pair.entity';
import { DexSyncService } from './services/dex-sync.service';
import { DexTokenService } from './services/dex-token.service';
import { PairService } from './services/pair.service';

@Module({
  imports: [
    AeModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Pair, DexToken]),
  ],
  providers: [PairService, DexTokenService, DexSyncService],
  exports: [PairService, DexTokenService],
  controllers: [PairsController, DexTokensController],
})
export class DexModule {
  //
}

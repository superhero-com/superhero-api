import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Pair } from './entities/pair.entity';
import { DexToken } from './entities/dex-token.entity';
import { PairService } from './services/pair.service';
import { DexTokenService } from './services/dex-token.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { PairsController } from './controllers/pairs.controller';
import { DexTokensController } from './controllers/dex-tokens.controller';

@Module({
  imports: [
    AeModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Pair, DexToken]),
  ],
  providers: [PairService, DexTokenService],
  exports: [PairService, DexTokenService],
  controllers: [PairsController, DexTokensController],
})
export class DexModule {
  //
}

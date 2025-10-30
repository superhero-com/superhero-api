import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from './entities/account.entity';
import { AccountService } from './services/account.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { AccountsController } from './controllers/accounts.controller';
import { PortfolioService } from './services/portfolio.service';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { TokensModule } from '@/tokens/tokens.module';

@Module({
  imports: [
    AeModule,
    TransactionsModule,
    TokensModule,
    TypeOrmModule.forFeature([Account, TokenHolder, Token, Transaction]),
  ],
  providers: [AccountService, PortfolioService],
  exports: [TypeOrmModule],
  controllers: [AccountsController],
})
export class AccountModule {
  //
}

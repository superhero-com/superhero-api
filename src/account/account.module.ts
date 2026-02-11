import { AeModule } from '@/ae/ae.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from './entities/account.entity';
import { AccountService } from './services/account.service';
import { TransactionsModule } from '@/transactions/transactions.module';
import { AccountsController } from './controllers/accounts.controller';
import { BclPnlController } from './controllers/bcl-pnl.controller';
import { PortfolioService } from './services/portfolio.service';
import { BclPnlService } from './services/bcl-pnl.service';
import { TokenHolder } from '@/tokens/entities/token-holders.entity';
import { Token } from '@/tokens/entities/token.entity';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { TokensModule } from '@/tokens/tokens.module';
import { LeaderboardService } from './services/leaderboard.service';
import { LeaderboardController } from './controllers/leaderboard.controller';
import { AccountLeaderboardSnapshot } from './entities/account-leaderboard-snapshot.entity';
import { LeaderboardSnapshotService } from './services/leaderboard-snapshot.service';

@Module({
  imports: [
    AeModule, // Includes CoinGeckoService
    TransactionsModule,
    TokensModule,
    TypeOrmModule.forFeature([
      Account,
      TokenHolder,
      Token,
      Transaction,
      AccountLeaderboardSnapshot,
    ]),
  ],
  providers: [
    AccountService,
    PortfolioService,
    BclPnlService,
    LeaderboardService,
    LeaderboardSnapshotService,
  ],
  exports: [TypeOrmModule, AccountService],
  controllers: [LeaderboardController, AccountsController, BclPnlController],
})
export class AccountModule {
  //
}

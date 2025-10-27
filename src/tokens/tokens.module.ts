import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { AeModule } from '@/ae/ae.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountTokensController } from './account-tokens.controller';
import { AnalyticTokensController } from './analytics-tokens.controller';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { TokenPerformance } from './entities/token-performance.entity';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
} from './queues/constants';
import { PullTokenInfoQueue } from './queues/pull-token-info.queue';
import { RemoveOldTokensQueue } from './queues/remove-old-tokens.queue';
import { SyncTokenHoldersQueue } from './queues/sync-token-holders.queue';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { UpdateTrendingTokensService } from './services/update-trending-tokens.service';
import { TokenPerformanceService } from './services/token-performance.service';
import { UpdateTokenPerformanceService } from './services/update-token-performance.service';
import { TokenPerformanceController } from './controllers/token-performance.controller';
import { TokenPerformanceView } from './entities/tokens-performance.view';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Token,
      TokenHolder,
      TokenPerformance,
      TokenPerformanceView, // Registered for queries, but synchronize:false prevents auto-creation
      Transaction,
    ]),
    AeModule,
    AePricingModule,
    BullModule.registerQueue(
      {
        name: PULL_TOKEN_INFO_QUEUE,
      },
      {
        name: SYNC_TOKEN_HOLDERS_QUEUE,
      },
      {
        name: DELETE_OLD_TOKENS_QUEUE,
      },
    ),
  ],
  controllers: [
    TokensController,
    AccountTokensController,
    AnalyticTokensController,
    TokenPerformanceController,
  ],
  providers: [
    TokensService,
    TokenWebsocketGateway,
    PullTokenInfoQueue,
    SyncTokenHoldersQueue,
    RemoveOldTokensQueue,
    UpdateTrendingTokensService,
    TokenPerformanceService,
    UpdateTokenPerformanceService,
  ],
  exports: [
    TypeOrmModule,
    TokensService,
    TokenWebsocketGateway,
    TokenPerformanceService,
  ],
})
export class TokensModule {
  onModuleInit() {
    //
  }
}

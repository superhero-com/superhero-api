import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { AeModule } from '@/ae/ae.module';
import { Transaction } from '@/plugins/bcl/entities/transaction.entity';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountTokensController } from './controllers/account-tokens.controller';
import { AnalyticTokensController } from './controllers/analytics-tokens.controller';
import { TokenPerformanceController } from './controllers/token-performance.controller';
import { TokensController } from './controllers/tokens.controller';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { TokenPerformanceView } from './entities/tokens-performance.view';
import { TokenWebsocketGateway } from './gateways/token-websocket.gateway';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
} from './queues/constants';
import { PullTokenInfoQueue } from './queues/pull-token-info.queue';
import { RemoveOldTokensQueue } from './queues/remove-old-tokens.queue';
import { SyncTokenHoldersQueue } from './queues/sync-token-holders.queue';
import { RefreshPerformanceViewService } from './services/refresh-performance-view.service';
import { TokensService } from './services/tokens.service';
import { UpdateTrendingTokensService } from './services/update-trending-tokens.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Token,
      TokenHolder,
      TokenPerformanceView,
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
    RefreshPerformanceViewService,
  ],
  exports: [TypeOrmModule, TokensService, TokenWebsocketGateway],
})
export class TokensModule {
  onModuleInit() {
    //
  }
}

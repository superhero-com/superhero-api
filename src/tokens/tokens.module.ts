import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_INFO_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from './queues/constants';
import { PullTokenInfoQueue } from './queues/pull-token-info.queue';
import { RemoveOldTokensQueue } from './queues/remove-old-tokens.queue';
import { SyncTokenHoldersQueue } from './queues/sync-token-holders.queue';
import { SyncTokensRanksQueue } from './queues/sync-tokens-ranks.queue';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { SYNC_TRANSACTIONS_QUEUE } from '@/transactions/queues/constants';
import { AePricingModule } from '@/ae-pricing/ae-pricing.module';
import { AccountTokensController } from './account-tokens.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Token, TokenHolder]),
    AeModule,
    AePricingModule,
    BullModule.registerQueue(
      {
        name: PULL_TOKEN_INFO_QUEUE,
      },
      {
        name: SYNC_TOKENS_RANKS_QUEUE,
      },
      {
        name: SYNC_TOKEN_HOLDERS_QUEUE,
      },
      {
        name: DELETE_OLD_TOKENS_QUEUE,
      },
      {
        name: SYNC_TRANSACTIONS_QUEUE,
      },
    ),
  ],
  controllers: [TokensController, AccountTokensController],
  providers: [
    TokensService,
    TokenWebsocketGateway,
    PullTokenInfoQueue,
    SyncTokensRanksQueue,
    SyncTokenHoldersQueue,
    RemoveOldTokensQueue,
  ],
  exports: [TypeOrmModule, TokensService, TokenWebsocketGateway],
})
export class TokensModule {
  onModuleInit() {
    //
  }
}

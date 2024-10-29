import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from 'src/ae/ae.module';
import { TokenHolder } from './entities/token-holders.entity';
import { Token } from './entities/token.entity';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { PullTokenPriceQueue } from './queues/pull-token-price.queue';
import { SyncTokensRanksQueue } from './queues/sync-tokens-ranks.queue';
import { BullModule } from '@nestjs/bull';
import {
  DELETE_OLD_TOKENS_QUEUE,
  PULL_TOKEN_PRICE_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from './queues/constants';
import { SyncTokenHoldersQueue } from './queues/sync-token-holders.queue';
import { RemoveOldTokensQueue } from './queues/remove-old-tokens.queue';

@Module({
  imports: [
    TypeOrmModule.forFeature([Token, TokenHolder]),
    AeModule,
    BullModule.registerQueue(
      {
        name: PULL_TOKEN_PRICE_QUEUE,
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
    ),
  ],
  controllers: [TokensController],
  providers: [
    TokensService,
    TokenWebsocketGateway,
    PullTokenPriceQueue,
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

import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from 'src/ae/ae.module';
import { TokenHistory } from 'src/tokens/entities/token-history.entity';
import { Token } from 'src/tokens/entities/token.entity';
import { TokensModule } from 'src/tokens/tokens.module';
import {
  PullTokenMetaDataQueue,
  PullTokenPriceQueue,
  SyncTokenHistoryQueue,
  SyncTokensRanksQueue,
} from './queues';
import {
  PULL_TOKEN_META_DATA_QUEUE,
  PULL_TOKEN_PRICE_QUEUE,
  SYNC_TOKEN_HISTORY_QUEUE,
  SYNC_TOKEN_HOLDERS_QUEUE,
  SYNC_TOKENS_RANKS_QUEUE,
} from './queues';
import { SyncTokenHoldersQueue } from './queues/sync-token-holders.queue';
import { PriceHistoryService, TransactionService } from './services';
import { TokenSaleService } from './token-sale.service';
import { TokenHolder } from 'src/tokens/entities/token-holders.entity';

@Module({
  imports: [
    AeModule,
    TokensModule,
    BullModule.registerQueue(
      {
        name: PULL_TOKEN_META_DATA_QUEUE,
      },
      {
        name: SYNC_TOKEN_HISTORY_QUEUE,
      },
      {
        name: PULL_TOKEN_PRICE_QUEUE,
      },
      {
        name: SYNC_TOKENS_RANKS_QUEUE,
      },
      {
        name: SYNC_TOKEN_HOLDERS_QUEUE,
      },
    ),
    TypeOrmModule.forFeature([Token, TokenHistory, TokenHolder]),
  ],
  providers: [
    TokenSaleService,
    //
    TransactionService,
    PriceHistoryService,
    SyncTokensRanksQueue,
    //
    PullTokenMetaDataQueue,
    SyncTokenHistoryQueue,
    PullTokenPriceQueue,
    SyncTokenHoldersQueue,
  ],
  exports: [TokenSaleService],
})
export class TokenSaleModule {}

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
  SYNC_TOKENS_RANKS_QUEUE,
} from './queues/constants';
import { PriceHistoryService, TransactionService } from './services';
import { TokenSaleService } from './token-sale.service';

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
    ),
    TypeOrmModule.forFeature([Token, TokenHistory]),
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
  ],
  exports: [TokenSaleService],
})
export class TokenSaleModule {}

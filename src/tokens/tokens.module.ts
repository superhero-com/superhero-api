import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TokenHistory } from './entities/token-history.entity';
import { Token } from './entities/token.entity';
import { HistoricalController } from './historical.controller';
import { TokenHistoryService } from './token-history.service';
import { TokensController } from './tokens.controller';
import { TokenWebsocketGateway } from './token-websocket.gateway';
import { TokensService } from './tokens.service';
import { TokenHolder } from './entities/token-holders.entity';
import { TokenTransaction } from './entities/token-transaction.entity';
import { BullModule } from '@nestjs/bull';
import { PULL_TOKEN_META_DATA_QUEUE } from 'src/token-sale/queues';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Token,
      TokenHistory,
      TokenHolder,
      TokenTransaction,
    ]),
    BullModule.registerQueue({
      name: PULL_TOKEN_META_DATA_QUEUE,
    }),
  ],
  controllers: [TokensController, HistoricalController],
  providers: [TokensService, TokenHistoryService, TokenWebsocketGateway],
  exports: [TypeOrmModule, TokensService, TokenWebsocketGateway],
})
export class TokensModule {
  onModuleInit() {
    //
  }
}

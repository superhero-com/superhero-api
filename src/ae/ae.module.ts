import { Module } from '@nestjs/common';
import { WebSocketService } from './websocket.service';
import { AeSdkService } from './ae-sdk.service';
import { CoinGeckoService } from './coin-gecko.service';

@Module({
  providers: [WebSocketService, AeSdkService, CoinGeckoService],
  exports: [WebSocketService, AeSdkService, CoinGeckoService],
})
export class AeModule {}

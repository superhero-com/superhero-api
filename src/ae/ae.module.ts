import { Module } from '@nestjs/common';
import { WebSocketService } from './websocket.service';
import { AeSdkService } from './ae-sdk.service';
import { CoinGeckoService } from './coin-gecko.service';
import { TokenGatingService } from './token-gating.service';

@Module({
  providers: [
    WebSocketService,
    AeSdkService,
    TokenGatingService,
    CoinGeckoService,
  ],
  exports: [
    WebSocketService,
    AeSdkService,
    TokenGatingService,
    CoinGeckoService,
  ],
})
export class AeModule {
  //
}

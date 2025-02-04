import { Module } from '@nestjs/common';
import { WebSocketService } from './websocket.service';
import { AeSdkService } from './ae-sdk.service';
import { CoinGeckoService } from './coin-gecko.service';
import { CommunityFactoryService } from './community-factory.service';

@Module({
  providers: [
    WebSocketService,
    AeSdkService,
    CommunityFactoryService,
    CoinGeckoService,
  ],
  exports: [
    WebSocketService,
    AeSdkService,
    CommunityFactoryService,
    CoinGeckoService,
  ],
})
export class AeModule {
  //
}

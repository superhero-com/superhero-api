import { Module, forwardRef } from '@nestjs/common';
import { WebSocketService } from './websocket.service';
import { AeSdkService } from './ae-sdk.service';
import { CoinGeckoService } from './coin-gecko.service';
import { CommunityFactoryService } from './community-factory.service';
import { AePricingModule } from '@/ae-pricing/ae-pricing.module';

@Module({
  imports: [forwardRef(() => AePricingModule)],
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

import { Controller, Get } from '@nestjs/common';
import { TokenGatingService } from './ae/token-gating.service';
import { ACTIVE_NETWORK } from './ae/utils/networks';
import { WebSocketService } from './ae/websocket.service';
import { AppService } from './app.service';
import { BCL_CONTRACTS } from './configs';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private tokenGatingService: TokenGatingService,
    private websocketService: WebSocketService,
  ) {}

  @Get('/api/stats')
  getApiStats() {
    return {
      apiVersion: this.appService.getApiVersion(),

      mdwConnected: this.websocketService.isConnected(),
    };
  }

  @Get('/api/contracts')
  getContracts() {
    return BCL_CONTRACTS[ACTIVE_NETWORK.networkId];
  }

  @Get('/api/factory')
  async getFactory() {
    return this.tokenGatingService.getCurrentFactory();
  }
}

import { Controller, Get } from '@nestjs/common';
import { ACTIVE_NETWORK } from './ae/utils/networks';
import { WebSocketService } from './ae/websocket.service';
import { AppService } from './app.service';
import { BCL_CONTRACTS } from './configs';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
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
}

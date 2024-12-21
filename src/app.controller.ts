import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { WebSocketService } from './ae/websocket.service';
import { ROOM_FACTORY_CONTRACTS } from './ae/utils/constants';
import { ACTIVE_NETWORK } from './ae/utils/networks';

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
    return ROOM_FACTORY_CONTRACTS[ACTIVE_NETWORK.networkId];
  }
}

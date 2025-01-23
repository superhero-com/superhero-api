import { Controller, Get } from '@nestjs/common';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';
import { AppService } from './app.service';
import { ApiOperation } from '@nestjs/swagger';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private communityFactoryService: CommunityFactoryService,
    private websocketService: WebSocketService,
  ) {
    //
  }

  @ApiOperation({ operationId: 'getApiStats' })
  @Get('/api/stats')
  getApiStats() {
    return {
      apiVersion: this.appService.getApiVersion(),

      mdwConnected: this.websocketService.isConnected(),
    };
  }

  @ApiOperation({ operationId: 'getContracts', deprecated: true })
  @Get('/api/contracts')
  async getContracts() {
    const factory = await this.communityFactoryService.getCurrentFactory();
    return [
      {
        contractId: factory.address,
        description: 'Community Factory',
      },
    ];
  }

  @ApiOperation({ operationId: 'getFactory' })
  @Get('/api/factory')
  async getFactory() {
    return this.communityFactoryService.getCurrentFactory();
  }
}

import { Controller, Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import moment from 'moment';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';
import { AppService } from './app.service';

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
  @Get('/stats')
  async getApiStats() {
    const duration = moment.duration(moment().diff(this.appService.startedAt));
    return {
      apiVersion: this.appService.getApiVersion(),

      mdwConnected: this.websocketService.isConnected(),
      uptime: `${duration.days()}d ${duration.hours()}h ${duration.minutes()}m ${duration.seconds()}s`,
      uptimeDurationSeconds: duration.asSeconds(),
    };
  }

  @ApiOperation({ operationId: 'getContracts', deprecated: true })
  @Get('/contracts')
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
  @Get('/factory')
  async getFactory() {
    return this.communityFactoryService.getCurrentFactory();
  }
}

import { Controller, Get } from '@nestjs/common';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';
import { AppService } from './app.service';
import { ApiOperation } from '@nestjs/swagger';
import { SyncBlocksService } from './bcl/services/sync-blocks.service';
import moment from 'moment';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private communityFactoryService: CommunityFactoryService,
    private websocketService: WebSocketService,
    private syncBlocksService: SyncBlocksService,
  ) {
    //
  }

  @ApiOperation({ operationId: 'getApiStats' })
  @Get('/api/stats')
  async getApiStats() {
    const duration = moment.duration(moment().diff(this.appService.startedAt));
    return {
      fullSyncing: this.syncBlocksService.fullSyncing,
      currentBlockNumber: this.syncBlocksService.currentBlockNumber,
      bclBlockNumber: this.syncBlocksService.bclBlockNumber,
      syncingLatestBlocks: this.syncBlocksService.syncingLatestBlocks,
      lastSyncedBlockNumber: this.syncBlocksService.lastSyncedBlockNumber,
      remainingBlocksToSync: this.syncBlocksService.remainingBlocksToSync,
      apiVersion: this.appService.getApiVersion(),

      mdwConnected: this.websocketService.isConnected(),
      uptime: `${duration.days()}d ${duration.hours()}h ${duration.minutes()}m ${duration.seconds()}s`,
      uptimeDurationSeconds: duration.asSeconds(),
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

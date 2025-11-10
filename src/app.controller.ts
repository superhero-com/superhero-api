import { Controller, Get } from '@nestjs/common';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';
import { AppService } from './app.service';
import { ApiOperation } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SyncState } from './mdw-sync/entities/sync-state.entity';
import { IndexerService } from './mdw-sync/services/indexer.service';
import moment from 'moment';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private communityFactoryService: CommunityFactoryService,
    private websocketService: WebSocketService,
    @InjectRepository(SyncState)
    private syncStateRepository: Repository<SyncState>,
    private indexerService: IndexerService,
  ) {
    //
  }

  @ApiOperation({ operationId: 'getApiStats' })
  @Get('/stats')
  async getApiStats() {
    const duration = moment.duration(moment().diff(this.appService.startedAt));
    const syncState = await this.syncStateRepository.findOne({
      where: { id: 'global' },
    });

    const factory = await this.communityFactoryService.getCurrentFactory();
    const bclBlockNumber = factory.deployed_at_block_height || 0;
    const tipHeight = syncState?.tip_height || 0;
    const backwardSyncedHeight = syncState?.backward_synced_height ?? tipHeight;
    const remainingBlocksToSync = Math.max(0, backwardSyncedHeight);

    return {
      fullSyncing: this.indexerService.getIsRunning(),
      currentBlockNumber: tipHeight,
      bclBlockNumber: bclBlockNumber,
      syncingLatestBlocks: this.indexerService.getIsRunning(),
      lastSyncedBlockNumber: backwardSyncedHeight,
      remainingBlocksToSync: remainingBlocksToSync,
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

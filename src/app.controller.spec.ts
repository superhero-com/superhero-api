/* eslint-disable @typescript-eslint/no-unused-vars */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';
import { SyncState } from './mdw-sync/entities/sync-state.entity';
import { IndexerService } from './mdw-sync/services/indexer.service';

describe('AppController', () => {
  let appController: AppController;
  let appService: AppService;
  let communityFactoryService: CommunityFactoryService;
  let websocketService: WebSocketService;
  let syncStateRepository: { findOne: jest.Mock };
  let indexerService: IndexerService;

  beforeEach(async () => {
    syncStateRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'global',
        tip_height: 250,
        backward_synced_height: 200,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: {
            startedAt: new Date(Date.now() - 60_000),
            getApiVersion: jest.fn().mockReturnValue('1.0.0'),
          },
        },
        {
          provide: CommunityFactoryService,
          useValue: {
            getCurrentFactory: jest.fn().mockResolvedValue({
              address: 'ct_123',
              deployed_at_block_height: 123,
            }),
          },
        },
        {
          provide: WebSocketService,
          useValue: {
            isConnected: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: getRepositoryToken(SyncState),
          useValue: syncStateRepository,
        },
        {
          provide: IndexerService,
          useValue: {
            getIsRunning: jest.fn().mockReturnValue(true),
          },
        },
      ],
    }).compile();

    appController = module.get<AppController>(AppController);
    appService = module.get<AppService>(AppService);
    communityFactoryService = module.get<CommunityFactoryService>(
      CommunityFactoryService,
    );
    websocketService = module.get<WebSocketService>(WebSocketService);
    indexerService = module.get<IndexerService>(IndexerService);
  });

  it('should be defined', () => {
    expect(appController).toBeDefined();
  });

  it('should return API stats', async () => {
    const result = await appController.getApiStats();
    expect(syncStateRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'global' },
    });
    expect(indexerService.getIsRunning).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        apiVersion: '1.0.0',
        mdwConnected: true,
        fullSyncing: true,
        syncingLatestBlocks: true,
        currentBlockNumber: 250,
        lastSyncedBlockNumber: 200,
        remainingBlocksToSync: 200,
        bclBlockNumber: 123,
      }),
    );
    expect(typeof result.uptime).toBe('string');
    expect(result.uptimeDurationSeconds).toBeGreaterThan(0);
  });

  it('should return contracts', async () => {
    const result = await appController.getContracts();
    expect(communityFactoryService.getCurrentFactory).toHaveBeenCalled();
    expect(result).toEqual([
      {
        contractId: 'ct_123',
        description: 'Community Factory',
      },
    ]);
  });

  it('should return factory details', async () => {
    const result = await appController.getFactory();
    expect(communityFactoryService.getCurrentFactory).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        address: 'ct_123',
        deployed_at_block_height: 123,
      }),
    );
  });
});

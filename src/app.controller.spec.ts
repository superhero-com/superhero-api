import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommunityFactoryService } from './ae/community-factory.service';
import { WebSocketService } from './ae/websocket.service';

describe('AppController', () => {
  let appController: AppController;
  let appService: AppService;
  let communityFactoryService: CommunityFactoryService;
  let websocketService: WebSocketService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: {
            getApiVersion: jest.fn().mockReturnValue('1.0.0'),
          },
        },
        {
          provide: CommunityFactoryService,
          useValue: {
            getCurrentFactory: jest
              .fn()
              .mockResolvedValue({ address: 'ct_123' }),
          },
        },
        {
          provide: WebSocketService,
          useValue: {
            isConnected: jest.fn().mockReturnValue(true),
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
  });

  it('should be defined', () => {
    expect(appController).toBeDefined();
  });

  it('should return API stats', () => {
    const result = appController.getApiStats();
    expect(result).toEqual({ apiVersion: '1.0.0', mdwConnected: true });
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
    expect(result).toEqual({ address: 'ct_123' });
  });
});

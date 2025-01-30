import { Test, TestingModule } from '@nestjs/testing';
import { CommunityFactoryService } from './community-factory.service';
import { AeSdkService } from './ae-sdk.service';
import { Encoded } from '@aeternity/aepp-sdk';
import { initCommunityFactory } from 'bctsl-sdk';
import { ACTIVE_NETWORK, ACTIVE_NETWORK_ID, BCL_FACTORY } from '@/configs';
import { ICommunityFactorySchema } from '@/utils/types';

jest.mock('bctsl-sdk', () => ({
  initCommunityFactory: jest.fn(),
}));

describe('CommunityFactoryService', () => {
  let service: CommunityFactoryService;
  let aeSdkService: AeSdkService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityFactoryService,
        {
          provide: AeSdkService,
          useValue: {
            sdk: {}, // Mock AeSdk instance
          },
        },
      ],
    }).compile();

    service = module.get<CommunityFactoryService>(CommunityFactoryService);
    aeSdkService = module.get<AeSdkService>(AeSdkService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should load a factory when not cached', async () => {
    const mockFactory = {
      contract: {
        get_state: jest.fn().mockResolvedValue({ decodedResult: {} }),
      },
    };
    (initCommunityFactory as jest.Mock).mockResolvedValue(mockFactory);

    const address = 'ct_123' as Encoded.ContractAddress;
    const result = await service.loadFactory(address);

    expect(initCommunityFactory).toHaveBeenCalledWith(
      aeSdkService.sdk,
      address,
    );
    expect(service.factories[address]).toEqual(mockFactory);
    expect(result).toEqual(mockFactory);
  });

  it('should return cached factory if already loaded', async () => {
    const address = 'ct_123' as Encoded.ContractAddress;
    const mockFactory = { contract: {} } as any;
    service.factories[address] = mockFactory;

    const result = await service.loadFactory(address);

    expect(initCommunityFactory).not.toHaveBeenCalled();
    expect(result).toEqual(mockFactory);
  });

  it('should return cached factory schema if available', async () => {
    const factoryAddress = 'ct_123' as Encoded.ContractAddress;
    const mockSchema: ICommunityFactorySchema = BCL_FACTORY[ACTIVE_NETWORK_ID];
    service.cachedFactorySchema[factoryAddress] = mockSchema;

    const result = await service.getCurrentFactory();

    expect(result).toEqual(mockSchema);
  });

  it('should fetch and populate factory collections if not cached', async () => {
    const factoryAddress = 'ct_123' as Encoded.ContractAddress;
    const mockFactoryInstance = {
      contract: {
        get_state: jest.fn().mockResolvedValue({
          decodedResult: {
            collection_registry: [
              [
                'name-ak_1',
                {
                  allowed_name_length: 10,
                  allowed_name_chars: [{ ascii: ['97', '98', '99'] }],
                },
              ],
            ],
          },
        }),
      },
    };

    (initCommunityFactory as jest.Mock).mockResolvedValue(mockFactoryInstance);
    BCL_FACTORY[ACTIVE_NETWORK.networkId] = {
      address: factoryAddress,
      collections: {},
    } as ICommunityFactorySchema;

    const result = await service.getCurrentFactory();

    expect(initCommunityFactory).toHaveBeenCalledWith(
      aeSdkService.sdk,
      factoryAddress,
    );
    expect(result.collections['name-ak_1']).toBeDefined();
    expect(result.collections['name-ak_1'].allowed_name_length).toBe('10');
  });
});

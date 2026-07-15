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

  describe('mapCollectionInfo', () => {
    const collectionId = 'CHINESE-ak_deployer' as const;
    const factory = {
      collections: {
        [collectionId]: {
          id: collectionId,
          name: 'CHINESE',
          description: 'Chinese collection',
          allowed_name_length: '20',
          // Bulky per-char rules that must NOT leak into the trimmed output.
          allowed_name_chars: [{ ascii: [97, 98, 99] }],
        },
      },
    } as unknown as ICommunityFactorySchema;

    it('maps a known collection id to its trimmed metadata', () => {
      expect(service.mapCollectionInfo(factory, collectionId)).toEqual({
        id: collectionId,
        name: 'CHINESE',
        description: 'Chinese collection',
        allowed_name_length: '20',
      });
    });

    it('omits allowed_name_chars from the mapped result', () => {
      const result = service.mapCollectionInfo(factory, collectionId);
      expect(result).not.toHaveProperty('allowed_name_chars');
    });

    it('returns null for an unknown collection id', () => {
      expect(service.mapCollectionInfo(factory, 'UNKNOWN-ak_x')).toBeNull();
    });

    it.each([[undefined], [null], ['']])(
      'returns null for an empty collection id (%p)',
      (collection) => {
        expect(
          service.mapCollectionInfo(factory, collection as any),
        ).toBeNull();
      },
    );
  });

  describe('getCollectionInfo', () => {
    const collectionId = 'CHINESE-ak_deployer' as const;

    beforeEach(() => {
      const factoryAddress = 'ct_cached' as Encoded.ContractAddress;
      BCL_FACTORY[ACTIVE_NETWORK.networkId] = {
        address: factoryAddress,
      } as ICommunityFactorySchema;
      // Prime the cache so getCurrentFactory resolves without touching the chain.
      service.cachedFactorySchema[factoryAddress] = {
        address: factoryAddress,
        collections: {
          [collectionId]: {
            id: collectionId,
            name: 'CHINESE',
            description: 'Chinese collection',
            allowed_name_length: '20',
            allowed_name_chars: [],
          },
        },
      } as unknown as ICommunityFactorySchema;
    });

    it('resolves a known collection id against the current factory', async () => {
      await expect(service.getCollectionInfo(collectionId)).resolves.toEqual({
        id: collectionId,
        name: 'CHINESE',
        description: 'Chinese collection',
        allowed_name_length: '20',
      });
    });

    it('short-circuits to null for an empty id without loading the factory', async () => {
      await expect(service.getCollectionInfo('')).resolves.toBeNull();
      expect(initCommunityFactory).not.toHaveBeenCalled();
    });

    it('returns null when the id is unknown to the current factory', async () => {
      await expect(
        service.getCollectionInfo('UNKNOWN-ak_x'),
      ).resolves.toBeNull();
    });
  });
});

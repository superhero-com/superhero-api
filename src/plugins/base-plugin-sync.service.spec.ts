import { BasePluginSyncService } from './base-plugin-sync.service';
import { Contract } from '@aeternity/aepp-sdk';
import { Logger } from '@nestjs/common';

jest.mock('@aeternity/aepp-sdk', () => ({
  Contract: {
    initialize: jest.fn().mockResolvedValue({ fake: true }),
  },
}));

class TestPluginService extends BasePluginSyncService {
  protected readonly logger = new Logger('TestPlugin');
  async processTransaction(): Promise<void> {}
}

describe('BasePluginSyncService – contract LRU cache', () => {
  let service: TestPluginService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    const aeSdkService = { sdk: { getContext: () => ({}) } } as any;
    service = new TestPluginService(aeSdkService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('caches a contract instance and returns it on second call', async () => {
    const addr = 'ct_first' as any;
    const aci = {};

    const first = await service.getContract(addr, aci);
    const second = await service.getContract(addr, aci);

    expect(first).toBe(second);
    expect(Contract.initialize).toHaveBeenCalledTimes(1);
    expect(service.getCacheSize()).toBe(1);
  });

  it('evicts the stalest contract when cache exceeds MAX_CACHED_CONTRACTS', async () => {
    const original = BasePluginSyncService.MAX_CACHED_CONTRACTS;
    (BasePluginSyncService as any).MAX_CACHED_CONTRACTS = 3;

    try {
      const aci = {};
      jest.setSystemTime(1000);
      await service.getContract('ct_a' as any, aci);

      jest.setSystemTime(2000);
      await service.getContract('ct_b' as any, aci);

      jest.setSystemTime(3000);
      await service.getContract('ct_c' as any, aci);

      expect(service.getCacheSize()).toBe(3);

      // Touch ct_a so ct_b becomes the stalest
      jest.setSystemTime(4000);
      await service.getContract('ct_a' as any, aci);

      // Adding a 4th should evict the stalest (ct_b, lastUsedAt=2000)
      jest.setSystemTime(5000);
      await service.getContract('ct_d' as any, aci);
      expect(service.getCacheSize()).toBe(3);

      // ct_b was evicted — re-fetching it should call Contract.initialize again
      const initCalls = (Contract.initialize as jest.Mock).mock.calls.length;
      await service.getContract('ct_b' as any, aci);
      expect((Contract.initialize as jest.Mock).mock.calls.length).toBe(
        initCalls + 1,
      );
    } finally {
      (BasePluginSyncService as any).MAX_CACHED_CONTRACTS = original;
    }
  });

  it('does not evict when at or below the limit', async () => {
    const original = BasePluginSyncService.MAX_CACHED_CONTRACTS;
    (BasePluginSyncService as any).MAX_CACHED_CONTRACTS = 3;

    try {
      await service.getContract('ct_x' as any, {});
      await service.getContract('ct_y' as any, {});
      await service.getContract('ct_z' as any, {});

      expect(service.getCacheSize()).toBe(3);
      expect(Contract.initialize).toHaveBeenCalledTimes(3);
    } finally {
      (BasePluginSyncService as any).MAX_CACHED_CONTRACTS = original;
    }
  });
});

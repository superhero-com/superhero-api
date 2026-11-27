import { Plugin } from '@/plugins/plugin.interface';
import { PluginRegistryService } from './plugin-registry.service';

describe('Plugin coverage catch-up', () => {
  it('leaves existing plugins unchanged and retries failed coverage on the next tick', async () => {
    const legacy = { name: 'legacy', processBatch: jest.fn() };
    const interrupted = {
      name: 'interrupted',
      catchUpToHeight: jest
        .fn()
        .mockRejectedValueOnce(new Error('middleware unavailable'))
        .mockResolvedValue(undefined),
    };
    const healthy = {
      name: 'healthy',
      catchUpToHeight: jest.fn().mockResolvedValue(undefined),
    };
    const registry = new PluginRegistryService(
      [legacy, interrupted, healthy] as unknown as Plugin[],
      {} as any,
    );

    await expect(registry.catchUpToHeight(100)).resolves.toBeUndefined();
    expect(healthy.catchUpToHeight).toHaveBeenCalledWith(100);
    await registry.catchUpToHeight(101);
    expect(interrupted.catchUpToHeight).toHaveBeenLastCalledWith(101);
    expect(healthy.catchUpToHeight).toHaveBeenLastCalledWith(101);
    expect(legacy.processBatch).not.toHaveBeenCalled();
  });
});

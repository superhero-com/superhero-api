import { DexPlugin } from './dex.plugin';

describe('DexPlugin.onReorg', () => {
  const setup = () => {
    const dexPluginSyncService = {
      handleReorg: jest.fn().mockResolvedValue(0),
    };
    const plugin = new DexPlugin(
      {} as any,
      {} as any,
      dexPluginSyncService as any,
    );
    const logError = jest
      .spyOn((plugin as any).logger, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn((plugin as any).logger, 'log').mockImplementation(() => {});
    return { plugin, dexPluginSyncService, logError };
  };

  it('does nothing for an empty hash list', async () => {
    const { plugin, dexPluginSyncService } = setup();

    await plugin.onReorg([]);

    expect(dexPluginSyncService.handleReorg).not.toHaveBeenCalled();
  });

  it('hands the removed hashes to the swap cleanup', async () => {
    const { plugin, dexPluginSyncService } = setup();

    await plugin.onReorg(['th_1', 'th_2']);

    expect(dexPluginSyncService.handleReorg).toHaveBeenCalledWith([
      'th_1',
      'th_2',
    ]);
  });

  it('names the removed txs when the cleanup fails', async () => {
    const { plugin, dexPluginSyncService, logError } = setup();
    dexPluginSyncService.handleReorg.mockRejectedValue(
      new Error('pool timeout'),
    );

    await expect(plugin.onReorg(['th_1', 'th_2'])).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('th_1, th_2'),
      expect.any(String),
    );
  });
});

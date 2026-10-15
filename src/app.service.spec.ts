import { Logger } from '@nestjs/common';
import { AppService } from './app.service';

describe('AppService startup lifecycle', () => {
  let service: AppService;
  let factory: { getCurrentFactory: jest.Mock };
  let prices: { pullAndSaveCoinCurrencyRates: jest.Mock };
  let gecko: { syncAllFromApi: jest.Mock };
  let queue: { empty: jest.Mock; add: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    factory = {
      getCurrentFactory: jest.fn().mockResolvedValue({ address: 'fixture' }),
    };
    prices = {
      pullAndSaveCoinCurrencyRates: jest.fn().mockResolvedValue(undefined),
    };
    gecko = { syncAllFromApi: jest.fn().mockResolvedValue(undefined) };
    queue = {
      empty: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    };
    service = new AppService(
      factory as any,
      prices as any,
      gecko as any,
      queue as any,
    );
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits for application bootstrap and cancels pending work during shutdown', async () => {
    await jest.advanceTimersByTimeAsync(10000);
    expect(factory.getCurrentFactory).not.toHaveBeenCalled();
    service.onApplicationBootstrap();
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5000);
    expect(factory.getCurrentFactory).not.toHaveBeenCalled();
    expect(queue.empty).not.toHaveBeenCalled();
  });

  it('contains delayed warm-up failures instead of rejecting outside Nest', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    queue.add.mockRejectedValue(new Error('Connection is closed'));
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5000);
    expect(warning).toHaveBeenCalled();
    expect(gecko.syncAllFromApi).not.toHaveBeenCalled();
  });

  it('stops between asynchronous initialization steps after shutdown', async () => {
    let release!: (value: { address: string }) => void;
    factory.getCurrentFactory.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = service.init();
    service.onModuleDestroy();
    release({ address: 'fixture' });
    await pending;
    expect(queue.empty).not.toHaveBeenCalled();
    expect(prices.pullAndSaveCoinCurrencyRates).not.toHaveBeenCalled();
  });

  it('does not persist prices after an in-flight fetch completes during shutdown', async () => {
    let release!: () => void;
    gecko.syncAllFromApi.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = service.syncAeCoinPricing();
    service.onModuleDestroy();
    release();
    await pending;
    expect(prices.pullAndSaveCoinCurrencyRates).not.toHaveBeenCalled();
  });
});

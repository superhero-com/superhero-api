import { SocialGraphWorkerService } from './social-graph-worker.service';

describe('Social graph event-driven scheduling', () => {
  let worker: SocialGraphWorkerService;
  let callbacks: Record<string, (...args: any[]) => void>;
  let stops: jest.Mock[];
  let tick: jest.SpyInstance;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.SOCIAL_GRAPH_WORKER_ENABLED;
    process.env.SOCIAL_GRAPH_WORKER_ENABLED = 'true';
    jest.useFakeTimers();
    callbacks = {};
    stops = [];
    const subscribe = (name: string) => (callback, source?: string) => {
      if (name === 'micro' || name === 'key') expect(source).toBe('node');
      callbacks[name] = callback;
      const stop = jest.fn();
      stops.push(stop);
      return stop;
    };
    worker = new SocialGraphWorkerService(
      {} as any,
      {} as any,
      { isConfigured: () => true } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        subscribeForMicroBlocksUpdates: subscribe('micro'),
        subscribeForKeyBlocksUpdates: subscribe('key'),
        subscribeForConnection: subscribe('connect'),
      } as any,
      {} as any,
    );
    tick = jest.spyOn(worker, 'tick').mockResolvedValue('idle');
  });
  afterEach(() => {
    worker.onModuleDestroy();
    jest.useRealTimers();
    if (previous === undefined) delete process.env.SOCIAL_GRAPH_WORKER_ENABLED;
    else process.env.SOCIAL_GRAPH_WORKER_ENABLED = previous;
  });
  it('boots once, coalesces websocket hints, catches up on reconnect, and never polls while idle', async () => {
    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60000);
    expect(tick).toHaveBeenCalledTimes(1);
    callbacks.micro({ hash: 'mh_one', height: 5 });
    callbacks.key({ hash: 'kh_five', height: 5 });
    worker.requestSync();
    worker.requestSync();
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    callbacks.connect();
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);
    worker.onModuleDestroy();
    stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
    callbacks.micro({ hash: 'mh_two', height: 5 });
    await jest.advanceTimersByTimeAsync(60000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
  it('drains bounded checkpoint pages, retries failures and preserves notifications received during a pass', async () => {
    tick
      .mockResolvedValueOnce('progress')
      .mockImplementationOnce(async () => {
        worker.requestSync();
        return 'idle';
      })
      .mockRejectedValueOnce(new Error('RPC unavailable'));
    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(10);
    expect(tick).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(60000);
    expect(tick).toHaveBeenCalledTimes(4);
  });
});

import { Logger } from '@nestjs/common';
import { PostService } from './post.service';

describe('PostService startup lifecycle', () => {
  let service: PostService;
  let clear: jest.SpyInstance;
  let pull: jest.SpyInstance;
  let repair: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new PostService({} as any, {} as any, {} as any);
    clear = jest
      .spyOn(service as any, 'clearNonCompatibleData')
      .mockResolvedValue(undefined);
    pull = jest
      .spyOn(service, 'pullLatestPostsForContracts')
      .mockResolvedValue(undefined);
    repair = jest
      .spyOn(service, 'fixOrphanedComments')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runs delayed maintenance only after application bootstrap', async () => {
    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(clear).not.toHaveBeenCalled();
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('cancels startup maintenance when shutdown precedes the timer', async () => {
    service.onApplicationBootstrap();
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(clear).not.toHaveBeenCalled();
  });

  it('contains database failures in the deferred task', async () => {
    const error = new Error('Driver not Connected');
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    clear.mockRejectedValue(error);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(log).toHaveBeenCalledWith('Post startup maintenance failed', error);
    expect(pull).not.toHaveBeenCalled();
  });

  it('does not begin the next operation after shutdown during cleanup', async () => {
    let release!: () => void;
    clear.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    const pending = service.sync();
    service.onModuleDestroy();
    release();
    await pending;
    expect(pull).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });
});

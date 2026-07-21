import { FeedSessionService } from './feed-session.service';

describe('FeedSessionService', () => {
  let redis: any;
  let service: FeedSessionService;
  const config = { feedSessionTtlMs: 1000 } as any;

  beforeEach(() => {
    redis = {
      setEx: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(undefined),
    };
    service = new FeedSessionService(redis, config);
  });

  it('mints a token mapped to the address with the configured TTL', async () => {
    const { token, expiresAt } = await service.mint('ak_owner');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(redis.setEx).toHaveBeenCalledWith(
      `notif:feed-session:${token}`,
      'ak_owner',
      1000,
    );
    expect(expiresAt).toBeInstanceOf(Date);
  });

  it('resolves a token to its owner address', async () => {
    redis.get.mockResolvedValue('ak_owner');
    await expect(service.resolve('tok')).resolves.toBe('ak_owner');
    expect(redis.get).toHaveBeenCalledWith('notif:feed-session:tok');
  });

  it('returns null for an empty token without hitting redis', async () => {
    await expect(service.resolve('')).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('revokes a token', async () => {
    await service.revoke('tok');
    expect(redis.del).toHaveBeenCalledWith('notif:feed-session:tok');
  });
});

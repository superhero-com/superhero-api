import { DeviceRegistryService } from './device-registry.service';
import { REDIS_KEYS } from '../notifications.constants';

describe('DeviceRegistryService', () => {
  let redis: any;
  let repo: any;
  let service: DeviceRegistryService;

  beforeEach(() => {
    redis = {
      sIsMember: jest.fn(),
      sAdd: jest.fn().mockResolvedValue(undefined),
      sRem: jest.fn().mockResolvedValue(undefined),
      replaceSet: jest.fn().mockResolvedValue(undefined),
    };
    repo = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    service = new DeviceRegistryService(redis, repo);
  });

  it('hasDevices reflects Redis set membership', async () => {
    redis.sIsMember.mockResolvedValue(true);
    await expect(service.hasDevices('ak_a')).resolves.toBe(true);
    expect(redis.sIsMember).toHaveBeenCalledWith(REDIS_KEYS.hasDevices, 'ak_a');

    redis.sIsMember.mockResolvedValue(false);
    await expect(service.hasDevices('ak_b')).resolves.toBe(false);
  });

  it('falls back to a DB count when Redis is unavailable', async () => {
    redis.sIsMember.mockRejectedValue(new Error('redis down'));
    repo.count.mockResolvedValue(1);
    await expect(service.hasDevices('ak_a')).resolves.toBe(true);
    expect(repo.count).toHaveBeenCalledWith({ where: { address: 'ak_a' } });
  });

  it('add/remove delegate to the Redis set', async () => {
    await service.addAddress('ak_a');
    expect(redis.sAdd).toHaveBeenCalledWith(REDIS_KEYS.hasDevices, ['ak_a']);

    await service.removeAddress('ak_a');
    expect(redis.sRem).toHaveBeenCalledWith(REDIS_KEYS.hasDevices, 'ak_a');
  });

  it('rebuild atomically REPLACES the set from distinct DB addresses', async () => {
    repo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ address: 'ak_a' }, { address: 'ak_b' }]),
    });
    await service.rebuild();
    expect(redis.replaceSet).toHaveBeenCalledWith(REDIS_KEYS.hasDevices, [
      'ak_a',
      'ak_b',
    ]);
    expect(redis.sAdd).not.toHaveBeenCalled();
  });

  it('rebuild replaces with an empty set when no DB rows exist (drops stale members)', async () => {
    repo.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    });
    await service.rebuild();
    expect(redis.replaceSet).toHaveBeenCalledWith(REDIS_KEYS.hasDevices, []);
  });
});

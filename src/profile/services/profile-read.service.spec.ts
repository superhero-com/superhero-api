import { Account } from '@/account/entities/account.entity';
import { ProfileCache } from '../entities/profile-cache.entity';
import { ProfileReadService } from './profile-read.service';

describe('ProfileReadService', () => {
  const createService = ({
    cache,
    account,
    caches = [],
    accounts = [],
  }: {
    cache?: ProfileCache | null;
    account?: Account | null;
    caches?: ProfileCache[];
    accounts?: Account[];
  }) => {
    const profileCacheRepository = {
      findOne: jest.fn().mockResolvedValue(cache ?? null),
      find: jest.fn().mockResolvedValue(caches),
    } as any;
    const accountRepository = {
      findOne: jest.fn().mockResolvedValue(account ?? null),
      find: jest.fn().mockResolvedValue(accounts),
    } as any;
    return new ProfileReadService(profileCacheRepository, accountRepository);
  };

  it('falls back to address when no selected name has a value', async () => {
    const service = createService({});
    const address = 'ak_2a5f9b9b4b0a8c2e5bc087ecbfc0ef6a1234567890abcd';

    const result = await service.getProfile(address);

    expect(result.public_name).toBe(address);
  });

  it('prefers chain_name over other name sources', async () => {
    const service = createService({
      cache: {
        address: 'ak_abc',
        username: 'custom_one',
        chain_name: 'chain_one',
      } as ProfileCache,
    });

    const result = await service.getProfile('ak_abc');

    expect(result.public_name).toBe('chain_one');
  });

  it('falls back to custom name when chain_name is missing', async () => {
    const service = createService({
      cache: {
        address: 'ak_chain1234567890',
        username: 'custom_one',
        chain_name: null,
      } as ProfileCache,
    });

    const result = await service.getProfile('ak_chain1234567890');

    expect(result.public_name).toBe('custom_one');
  });

  it('uses AddressLink x value from account links', async () => {
    const service = createService({
      cache: {
        address: 'ak_linked',
        x_username: 'stale_profile_registry_name',
      } as ProfileCache,
      account: {
        address: 'ak_linked',
        links: { x: '@FreshLinkedX' },
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_linked');

    expect(result.profile.x_username).toBe('freshlinkedx');
  });

  it('returns batch profiles in requested order', async () => {
    const service = createService({
      caches: [
        {
          address: 'ak_2',
          username: 'second',
        } as ProfileCache,
        {
          address: 'ak_1',
          username: 'first',
        } as ProfileCache,
      ],
    });

    const result = await service.getProfilesByAddresses(['ak_1', 'ak_2']);

    expect(result.map((item) => item.address)).toEqual(['ak_1', 'ak_2']);
    expect(result[0].public_name).toBe('first');
    expect(result[1].public_name).toBe('second');
  });

  it('returns paginated feed from cache records', async () => {
    const service = createService({
      caches: [
        {
          address: 'ak_1',
          username: 'user1',
          bio: 'bio1',
          public_name: 'user1',
        } as ProfileCache,
      ],
    });

    const feed = await service.getProfileFeed(20, 0);

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].address).toBe('ak_1');
    expect(feed.pagination.limit).toBe(20);
    expect(feed.pagination.offset).toBe(0);
  });
});

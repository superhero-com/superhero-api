import { Account } from '@/account/entities/account.entity';
import { ProfileCache } from '../entities/profile-cache.entity';
import { ProfileContractService } from './profile-contract.service';
import { ProfileReadService } from './profile-read.service';

describe('ProfileReadService', () => {
  it('keeps public_name empty when no selected name has a value', async () => {
    const profileCacheRepository = {
      findOne: jest.fn().mockResolvedValue(null as ProfileCache | null),
    } as any;
    const accountRepository = {
      findOne: jest.fn().mockResolvedValue(null as Account | null),
    } as any;
    const profileContractService = {
      getProfile: jest.fn().mockResolvedValue(null),
    } as unknown as ProfileContractService;

    const service = new ProfileReadService(
      profileCacheRepository,
      accountRepository,
      profileContractService,
    );

    const address = 'ak_2a5f9b9b4b0a8c2e5bc087ecbfc0ef6a1234567890abcd';
    const result = await service.getProfile(address);

    expect(result.public_name).toBe('');
  });

  it('prefers selected display source when available', async () => {
    const profileCacheRepository = {
      findOne: jest.fn().mockResolvedValue({
        address: 'ak_abc',
        username: 'custom_one',
        chain_name: 'chain_one',
        x_username: 'x_one',
        display_source: 'x',
      } as ProfileCache),
    } as any;
    const accountRepository = {
      findOne: jest.fn().mockResolvedValue(null as Account | null),
    } as any;
    const profileContractService = {
      getProfile: jest.fn().mockResolvedValue(null),
    } as unknown as ProfileContractService;

    const service = new ProfileReadService(
      profileCacheRepository,
      accountRepository,
      profileContractService,
    );
    const result = await service.getProfile('ak_abc');

    expect(result.public_name).toBe('x_one');
  });

  it('keeps public_name empty when custom display source has no value', async () => {
    const profileCacheRepository = {
      findOne: jest.fn().mockResolvedValue({
        address: 'ak_abc1234567890',
        username: null,
        chain_name: 'chain_one',
        x_username: 'x_one',
        display_source: 'custom',
      } as ProfileCache),
    } as any;
    const accountRepository = {
      findOne: jest.fn().mockResolvedValue(null as Account | null),
    } as any;
    const profileContractService = {
      getProfile: jest.fn().mockResolvedValue(null),
    } as unknown as ProfileContractService;

    const service = new ProfileReadService(
      profileCacheRepository,
      accountRepository,
      profileContractService,
    );
    const result = await service.getProfile('ak_abc1234567890');

    expect(result.public_name).toBe('');
  });

  it('keeps public_name empty when chain display source has no value', async () => {
    const profileCacheRepository = {
      findOne: jest.fn().mockResolvedValue({
        address: 'ak_chain1234567890',
        username: 'custom_one',
        chain_name: null,
        x_username: 'x_one',
        display_source: 'chain',
      } as ProfileCache),
    } as any;
    const accountRepository = {
      findOne: jest.fn().mockResolvedValue(null as Account | null),
    } as any;
    const profileContractService = {
      getProfile: jest.fn().mockResolvedValue(null),
    } as unknown as ProfileContractService;

    const service = new ProfileReadService(
      profileCacheRepository,
      accountRepository,
      profileContractService,
    );
    const result = await service.getProfile('ak_chain1234567890');

    expect(result.public_name).toBe('');
  });

  it('returns batch profiles in requested order', async () => {
    const profileCacheRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([
        {
          address: 'ak_2',
          username: 'second',
          display_source: 'custom',
        } as ProfileCache,
        {
          address: 'ak_1',
          username: 'first',
          display_source: 'custom',
        } as ProfileCache,
      ]),
    } as any;
    const accountRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    } as any;
    const profileContractService = {
      getProfile: jest.fn().mockResolvedValue(null),
    } as unknown as ProfileContractService;

    const service = new ProfileReadService(
      profileCacheRepository,
      accountRepository,
      profileContractService,
    );

    const result = await service.getProfilesByAddresses(['ak_1', 'ak_2']);
    expect(result.map((item) => item.address)).toEqual(['ak_1', 'ak_2']);
    expect(result[0].public_name).toBe('first');
    expect(result[1].public_name).toBe('second');
  });

  it('returns paginated feed from cache records', async () => {
    const profileCacheRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([
        {
          address: 'ak_1',
          username: 'user1',
          bio: 'bio1',
          display_source: 'custom',
          public_name: 'user1',
        } as ProfileCache,
      ]),
    } as any;
    const accountRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    } as any;
    const profileContractService = {
      getProfile: jest.fn().mockResolvedValue(null),
    } as unknown as ProfileContractService;

    const service = new ProfileReadService(
      profileCacheRepository,
      accountRepository,
      profileContractService,
    );

    const feed = await service.getProfileFeed(20, 0);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].address).toBe('ak_1');
    expect(feed.pagination.limit).toBe(20);
    expect(feed.pagination.offset).toBe(0);
  });
});

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
    const socialGraphCountRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    } as any;
    return new ProfileReadService(
      profileCacheRepository,
      accountRepository,
      socialGraphCountRepository,
    );
  };

  it('falls back to address when no selected name has a value', async () => {
    const service = createService({});
    const address = 'ak_2a5f9b9b4b0a8c2e5bc087ecbfc0ef6a1234567890abcd';

    const result = await service.getProfile(address);

    expect(result.public_name).toBe(address);
  });

  it('surfaces follower and following counts when the social graph is configured', async () => {
    const KEY = 'SOCIAL_GRAPH_CONTRACT_ADDRESS';
    const original = process.env[KEY];
    process.env[KEY] = 'ct_configured';
    try {
      // Re-require so the module-level SOCIAL_GRAPH_ENABLED reads the set env.
      let ConfiguredProfileReadService: any;
      jest.isolateModules(() => {
        ConfiguredProfileReadService =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('./profile-read.service').ProfileReadService;
      });
      const service = new ConfiguredProfileReadService(
        { findOne: jest.fn().mockResolvedValue(null) },
        { findOne: jest.fn().mockResolvedValue(null) },
        {
          findOne: jest.fn().mockResolvedValue({
            address: 'ak_counts',
            followers_count: 7,
            following_count: 3,
          }),
        },
      );

      const result = await service.getProfile('ak_counts');

      expect(result.profile).toEqual(
        expect.objectContaining({
          followers_count: 7,
          following_count: 3,
        }),
      );
    } finally {
      if (original === undefined) {
        delete process.env[KEY];
      } else {
        process.env[KEY] = original;
      }
    }
  });

  it('returns zero counts when the address has no counts row', async () => {
    const KEY = 'SOCIAL_GRAPH_CONTRACT_ADDRESS';
    const original = process.env[KEY];
    process.env[KEY] = 'ct_configured';
    try {
      let ConfiguredProfileReadService: any;
      jest.isolateModules(() => {
        ConfiguredProfileReadService =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('./profile-read.service').ProfileReadService;
      });
      const service = new ConfiguredProfileReadService(
        { findOne: jest.fn().mockResolvedValue(null) },
        { findOne: jest.fn().mockResolvedValue(null) },
        { findOne: jest.fn().mockResolvedValue(null) },
      );

      const result = await service.getProfile('ak_nobody');

      expect(result.profile).toEqual(
        expect.objectContaining({
          followers_count: 0,
          following_count: 0,
        }),
      );
    } finally {
      if (original === undefined) {
        delete process.env[KEY];
      } else {
        process.env[KEY] = original;
      }
    }
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

  it('uses AddressLink prefered AENS name from account links', async () => {
    const service = createService({
      cache: {
        address: 'ak_preferred_linked',
        username: 'cached_username',
      } as ProfileCache,
      account: {
        address: 'ak_preferred_linked',
        links: { prefaens: 'hero.chain' },
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_preferred_linked');

    expect(result.profile.prefered_aens_name).toBe('hero.chain');
    expect(result.public_name).toBe('hero.chain');
  });

  it('prefers linked prefered AENS name over chain_name for public_name', async () => {
    const service = createService({
      cache: {
        address: 'ak_chain_preferred',
        chain_name: 'chain_one',
      } as ProfileCache,
      account: {
        address: 'ak_chain_preferred',
        links: { prefaens: 'hero.chain' },
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_chain_preferred');

    expect(result.profile.prefered_aens_name).toBe('hero.chain');
    expect(result.public_name).toBe('hero.chain');
  });

  it('prefers the live account chain_name over the cached copy', async () => {
    const service = createService({
      cache: {
        address: 'ak_renamed',
        chain_name: 'frozen.chain',
      } as ProfileCache,
      account: {
        address: 'ak_renamed',
        chain_name: 'current.chain',
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_renamed');

    expect(result.profile.chain_name).toBe('current.chain');
    expect(result.public_name).toBe('current.chain');
  });

  it('falls back to the cached chain_name when the account has none', async () => {
    const service = createService({
      cache: {
        address: 'ak_cache_only',
        chain_name: 'cached.chain',
      } as ProfileCache,
      account: {
        address: 'ak_cache_only',
        chain_name: null,
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_cache_only');

    expect(result.profile.chain_name).toBe('cached.chain');
    expect(result.public_name).toBe('cached.chain');
  });

  it('still prefers the linked prefered AENS name over a live chain_name', async () => {
    const service = createService({
      cache: {
        address: 'ak_pref_over_live',
        chain_name: 'frozen.chain',
      } as ProfileCache,
      account: {
        address: 'ak_pref_over_live',
        chain_name: 'current.chain',
        links: { prefaens: 'hero.chain' },
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_pref_over_live');

    expect(result.profile.chain_name).toBe('current.chain');
    expect(result.public_name).toBe('hero.chain');
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

  it('uses AddressLink bio value from account links', async () => {
    const service = createService({
      cache: {
        address: 'ak_bio_linked',
        bio: 'stale profile bio',
      } as ProfileCache,
      account: {
        address: 'ak_bio_linked',
        links: { bio: '  linked bio  ' },
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_bio_linked');

    expect(result.profile.bio).toBe('linked bio');
  });

  it('uses AddressLink site value from account links', async () => {
    const service = createService({
      account: {
        address: 'ak_site_linked',
        links: { site: 'example.com' },
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_site_linked');

    expect(result.profile.site).toBe('example.com');
  });

  it('returns null site when no AddressLink site exists', async () => {
    const service = createService({
      cache: {
        address: 'ak_no_site',
      } as ProfileCache,
    });

    const result = await service.getProfile('ak_no_site');

    expect(result.profile.site).toBeNull();
  });

  it('falls back to profile cache bio when no AddressLink bio exists', async () => {
    const service = createService({
      cache: {
        address: 'ak_cached_bio',
        bio: 'cached bio',
      } as ProfileCache,
      account: {
        address: 'ak_cached_bio',
        links: { x: 'linkedx' },
      } as unknown as Account,
    });

    const result = await service.getProfile('ak_cached_bio');

    expect(result.profile.bio).toBe('cached bio');
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

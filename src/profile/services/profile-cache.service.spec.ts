import { ProfileCacheService } from './profile-cache.service';

describe('ProfileCacheService', () => {
  const getService = () => {
    const profileCacheRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    } as any;
    const accountRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    } as any;

    const service = new ProfileCacheService(
      profileCacheRepository,
      accountRepository,
    );

    return { service, profileCacheRepository, accountRepository };
  };

  const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';

  it('does nothing for an empty address', async () => {
    const { service, profileCacheRepository, accountRepository } = getService();

    await service.syncFromAccountLinks('');

    expect(accountRepository.findOne).not.toHaveBeenCalled();
    expect(profileCacheRepository.upsert).not.toHaveBeenCalled();
  });

  it('creates a fresh row and bumps updated_at for a link-only account', async () => {
    const { service, profileCacheRepository, accountRepository } = getService();
    accountRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      chain_name: null,
      links: { bio: 'hello' },
    });

    await service.syncFromAccountLinks(ADDRESS, '1234');

    expect(profileCacheRepository.upsert).toHaveBeenCalledTimes(1);
    const [values, options] = profileCacheRepository.upsert.mock.calls[0];
    expect(values).toEqual(
      expect.objectContaining({
        address: ADDRESS,
        public_name: null,
        last_seen_micro_time: '1234',
      }),
    );
    // updated_at is derived from the event micro_time (epoch ms), not
    // wall-clock now, so the feed keeps chronological order across backfills.
    expect(values.updated_at).toEqual(new Date(1234));
    expect(options).toEqual({ conflictPaths: ['address'] });
    // Registry-only fields are never written, so they are preserved on update.
    expect(values).not.toHaveProperty('fullname');
    expect(values).not.toHaveProperty('username');
    expect(values).not.toHaveProperty('avatarurl');
  });

  it('prefers preferred AENS, then chain_name, then legacy username for public_name', async () => {
    const { service, profileCacheRepository, accountRepository } = getService();

    // Preferred AENS name overrides the middleware-derived chain name.
    accountRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      chain_name: 'hero.chain',
      links: { prefaens: 'other.chain' },
    });
    profileCacheRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      username: 'legacy',
    });
    await service.syncFromAccountLinks(ADDRESS);
    expect(profileCacheRepository.upsert.mock.calls[0][0].public_name).toBe(
      'other.chain',
    );

    // No preferred name → default to the middleware chain name.
    accountRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      chain_name: 'hero.chain',
      links: {},
    });
    await service.syncFromAccountLinks(ADDRESS);
    expect(profileCacheRepository.upsert.mock.calls[1][0].public_name).toBe(
      'hero.chain',
    );

    // Neither → fall back to the legacy username.
    accountRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      chain_name: null,
      links: {},
    });
    await service.syncFromAccountLinks(ADDRESS);
    expect(profileCacheRepository.upsert.mock.calls[2][0].public_name).toBe(
      'legacy',
    );
  });

  it('keeps the previous last_seen_micro_time when no microTime is provided', async () => {
    const { service, profileCacheRepository, accountRepository } = getService();
    accountRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      links: {},
    });
    profileCacheRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      last_seen_micro_time: '999',
    });

    await service.syncFromAccountLinks(ADDRESS);

    expect(
      profileCacheRepository.upsert.mock.calls[0][0].last_seen_micro_time,
    ).toBe('999');
    // updated_at follows the carried-over event time, not wall-clock now.
    expect(profileCacheRepository.upsert.mock.calls[0][0].updated_at).toEqual(
      new Date(999),
    );
  });

  it('falls back to wall-clock now when no usable micro_time exists', async () => {
    const { service, profileCacheRepository, accountRepository } = getService();
    accountRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      links: {},
    });

    const before = Date.now();
    await service.syncFromAccountLinks(ADDRESS);
    const after = Date.now();

    const updatedAt: Date =
      profileCacheRepository.upsert.mock.calls[0][0].updated_at;
    expect(updatedAt).toBeInstanceOf(Date);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('does not throw when the upsert fails', async () => {
    const { service, profileCacheRepository, accountRepository } = getService();
    accountRepository.findOne.mockResolvedValue({
      address: ADDRESS,
      links: {},
    });
    profileCacheRepository.upsert.mockRejectedValue(new Error('db down'));

    await expect(
      service.syncFromAccountLinks(ADDRESS, '1'),
    ).resolves.toBeUndefined();
  });
});

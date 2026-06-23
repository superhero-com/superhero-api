jest.mock('../profile.constants', () => ({
  PROFILE_X_POSTING_REWARD_AMOUNT_AE: '0.05',
  PROFILE_X_POSTING_REWARD_ENABLED: false,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS: 5000,
  PROFILE_X_POSTING_REWARD_KEYWORDS: ['superhero.com', 'superhero_chain'],
  PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS: 1,
  PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS: 60,
  PROFILE_X_REWARD_MIN_FOLLOWERS: 100,
}));

import { ProfileXApiClientService } from './profile-x-api-client.service';
import { ProfileXPostingRewardService } from './profile-x-posting-reward.service';

describe('ProfileXPostingRewardService disabled', () => {
  it('returns unavailable status and blocks manual recheck', async () => {
    const postingRewardRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    } as any;
    const service = new ProfileXPostingRewardService(
      postingRewardRepository,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      {} as any,
      { sdk: { spend: jest.fn() } } as any,
      {
        enqueueSpend: jest.fn(),
        getRewardAccount: jest.fn(),
      } as any,
      new ProfileXApiClientService(),
      { find: jest.fn(), update: jest.fn() } as any,
      { find: jest.fn(), update: jest.fn() } as any,
    );

    await expect(
      service.requestManualRecheck(
        'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      ),
    ).rejects.toMatchObject({
      status: 503,
    });

    await expect(
      service.getRewardStatus(
        'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      ),
    ).resolves.toMatchObject({
      status: 'not_started',
      error: 'Posting rewards are temporarily unavailable.',
    });
  });

  it('still surfaces settled per-post totals for a paid row while disabled', async () => {
    const ADDRESS = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
    const paidRow = { address: ADDRESS, status: 'paid', tx_hash: 'th_x' };
    const postingRewardRepository = {
      findOne: jest.fn().mockResolvedValue(paidRow),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    } as any;
    const postRewardLedgerRepository = {
      find: jest.fn(),
      update: jest.fn(),
      // getPerPostTotals aggregate.
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          select: () => qb,
          addSelect: () => qb,
          where: () => qb,
          andWhere: () => qb,
          getRawOne: async () => ({
            count: '2',
            aettos: '200000000000000000',
          }),
        };
        return qb;
      }),
    } as any;
    const service = new ProfileXPostingRewardService(
      postingRewardRepository,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      {} as any,
      { sdk: { spend: jest.fn() } } as any,
      { enqueueSpend: jest.fn(), getRewardAccount: jest.fn() } as any,
      new ProfileXApiClientService(),
      postRewardLedgerRepository,
      { find: jest.fn(), update: jest.fn() } as any,
    );

    await expect(service.getRewardStatus(ADDRESS)).resolves.toMatchObject({
      status: 'paid',
      per_post_total_paid_count: 2,
      per_post_total_paid_aettos: '200000000000000000',
    });
  });
});

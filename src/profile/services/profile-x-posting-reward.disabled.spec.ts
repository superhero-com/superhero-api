jest.mock('../profile.constants', () => ({
  PROFILE_X_POSTING_REWARD_AMOUNT_AE: '0.05',
  PROFILE_X_POSTING_REWARD_ENABLED: false,
  PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS: false,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS: 5000,
  PROFILE_X_POSTING_REWARD_KEYWORDS: ['superhero.com', 'superhero_chain'],
  PROFILE_X_POSTING_REWARD_MANUAL_RECHECK_COOLDOWN_SECONDS: 3600,
  PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS: 1,
  PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS: 60,
  PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS: 300,
  PROFILE_X_POSTING_REWARD_THRESHOLD: 10,
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
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
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      {} as any,
      { sdk: { spend: jest.fn() } } as any,
      {
        enqueueSpend: jest.fn(),
        getRewardAccount: jest.fn(),
      } as any,
      new ProfileXApiClientService(),
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
});

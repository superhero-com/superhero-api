jest.mock('../profile.constants', () => ({
  PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE: '0.01',
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
}));

import { ProfileXVerificationRewardService } from './profile-x-verification-reward.service';

describe('ProfileXVerificationRewardService', () => {
  it('converts AE amount to integer aettos before spend', async () => {
    const rewardRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockImplementation(async (value) => value),
    } as any;
    const aeSdkService = {
      sdk: {
        spend: jest.fn().mockResolvedValue({ hash: 'th_reward_1' }),
      },
    } as any;

    const service = new ProfileXVerificationRewardService(
      rewardRepository,
      aeSdkService,
    );
    (service as any).getRewardAccount = jest.fn().mockReturnValue({} as any);

    await service.sendRewardIfEligible(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'reward_user',
    );

    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
    expect(aeSdkService.sdk.spend).toHaveBeenCalledWith(
      '10000000000000000',
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      { onAccount: {} },
    );
  });
});

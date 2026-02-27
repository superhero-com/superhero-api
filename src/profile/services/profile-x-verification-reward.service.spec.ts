jest.mock('../profile.constants', () => ({
  PROFILE_X_VERIFICATION_REWARD_AMOUNT_AE: '0.01',
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
}));

import { ProfileXVerificationRewardService } from './profile-x-verification-reward.service';

describe('ProfileXVerificationRewardService', () => {
  const getService = (overrides?: {
    rewardRepository?: any;
    aeSdkService?: any;
    profileXInviteService?: any;
    profileSpendQueueService?: any;
  }) => {
    const rewardRepository =
      overrides?.rewardRepository ||
      ({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((value) => value),
        save: jest.fn().mockImplementation(async (value) => value),
      } as any);
    const aeSdkService =
      overrides?.aeSdkService ||
      ({
        sdk: {
          spend: jest.fn().mockResolvedValue({ hash: 'th_reward_1' }),
        },
      } as any);
    const profileXInviteService =
      overrides?.profileXInviteService ||
      ({
        processInviteeXVerified: jest.fn().mockResolvedValue(undefined),
      } as any);
    const profileSpendQueueService =
      overrides?.profileSpendQueueService ||
      ({
        enqueueSpend: jest.fn().mockImplementation(async (_k, work) => work()),
        getRewardAccount: jest.fn().mockReturnValue({}),
      } as any);

    const service = new ProfileXVerificationRewardService(
      rewardRepository,
      aeSdkService,
      profileXInviteService,
      profileSpendQueueService,
    );
    return {
      service,
      rewardRepository,
      aeSdkService,
      profileXInviteService,
      profileSpendQueueService,
    };
  };

  it('converts AE amount to integer aettos before spend', async () => {
    const { service, aeSdkService } = getService();

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

  it('triggers invite verification credit after successful payout', async () => {
    const { service, profileXInviteService } = getService();

    await service.sendRewardIfEligible(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'reward_user_hook',
    );

    expect(profileXInviteService.processInviteeXVerified).toHaveBeenCalledWith(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
    );
  });

  it('serializes spends across different recipients', async () => {
    let resolveFirstSpend: (() => void) | null = null;
    const aeSdkService = {
      sdk: {
        spend: jest
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveFirstSpend = () => resolve({ hash: 'th_reward_1' });
              }),
          )
          .mockResolvedValueOnce({ hash: 'th_reward_2' }),
      },
    } as any;
    let queue: Promise<void> = Promise.resolve();
    const profileSpendQueueService = {
      enqueueSpend: jest.fn().mockImplementation(async (_k, work) => {
        const current = queue.then(work, work);
        queue = current.then(
          () => undefined,
          () => undefined,
        );
        return current;
      }),
      getRewardAccount: jest.fn().mockReturnValue({}),
    } as any;
    const { service } = getService({ aeSdkService, profileSpendQueueService });

    const first = service.sendRewardIfEligible(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      'first_user',
    );
    const second = service.sendRewardIfEligible(
      'ak_2qUqjP8J5Mdrrnw9MhQN9jQHX8RWqA27RSh4BnhJrg5ioLHFgC',
      'second_user',
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
    expect(resolveFirstSpend).not.toBeNull();

    resolveFirstSpend?.();
    await Promise.all([first, second]);

    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(2);
    expect(aeSdkService.sdk.spend.mock.calls[0][1]).toBe(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
    );
    expect(aeSdkService.sdk.spend.mock.calls[1][1]).toBe(
      'ak_2qUqjP8J5Mdrrnw9MhQN9jQHX8RWqA27RSh4BnhJrg5ioLHFgC',
    );
  });

  it('rethrows spend failures after persisting failed status', async () => {
    const savedSnapshots: Array<{ status: string; error: string | null }> = [];
    const rewardRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockImplementation(async (value) => {
        savedSnapshots.push({
          status: value.status,
          error: value.error ?? null,
        });
        return value;
      }),
    } as any;
    const aeSdkService = {
      sdk: {
        spend: jest.fn().mockRejectedValue(new Error('boom')),
      },
    } as any;

    const { service } = getService({ rewardRepository, aeSdkService });

    await expect(
      service.sendRewardIfEligible(
        'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
        'broken_user',
      ),
    ).rejects.toThrow('boom');

    expect(savedSnapshots.some((entry) => entry.status === 'pending')).toBe(
      true,
    );
    expect(savedSnapshots.some((entry) => entry.status === 'failed')).toBe(
      true,
    );
    expect(savedSnapshots.some((entry) => entry.error === 'boom')).toBe(true);
  });

  it.each(['pending', 'paid'])(
    'does not reward another address when same X username is %s elsewhere',
    async (status) => {
      const rewardRepository = {
        findOne: jest.fn().mockImplementation(async ({ where }) => {
          if (where?.address) {
            return null;
          }
          if (
            where?.x_username === 'alice'
          ) {
            return {
              address: 'ak_first',
              x_username: 'alice',
              status,
            };
          }
          return null;
        }),
        create: jest.fn().mockImplementation((value) => value),
        save: jest.fn().mockImplementation(async (value) => value),
      } as any;
      const aeSdkService = {
        sdk: {
          spend: jest.fn(),
        },
      } as any;
      const { service } = getService({ rewardRepository, aeSdkService });

      await service.sendRewardIfEligible('ak_second', 'alice');

      expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
      expect(rewardRepository.save).not.toHaveBeenCalled();
    },
  );

  it('allows another address when same X username only has failed rewards', async () => {
    const rewardRepository = {
      findOne: jest.fn().mockImplementation(async ({ where }) => {
        if (where?.address) {
          return null;
        }
        // No paid/pending entry for this x_username.
        return null;
      }),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockImplementation(async (value) => value),
    } as any;
    const aeSdkService = {
      sdk: {
        spend: jest
          .fn()
          .mockResolvedValue({ hash: 'th_reward_failed_owner_b' }),
      },
    } as any;

    const { service } = getService({ rewardRepository, aeSdkService });

    await service.sendRewardIfEligible('ak_second', 'alice');

    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
    expect(aeSdkService.sdk.spend.mock.calls[0][1]).toBe('ak_second');
  });
});

jest.mock('../profile.constants', () => ({
  // The one thing that differs from profile-x-invite.service.spec.ts: rewards
  // switched on, so the milestone payout actually reaches the spend.
  PROFILE_REWARDS_DISABLED: false,
  PROFILE_X_INVITE_LINK_BASE_URL: 'https://example.app/invite',
  PROFILE_X_INVITE_CHALLENGE_TTL_SECONDS: 300,
  PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE: '0.02',
  PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
  PROFILE_X_INVITE_MILESTONE_THRESHOLD: 10,
  PROFILE_X_INVITE_PENDING_TIMEOUT_SECONDS: 300,
}));

import { decode } from '@aeternity/aepp-sdk';
import { ProfileXInviteService } from './profile-x-invite.service';

describe('invite milestone payout memo', () => {
  it('sends the milestone reward with a memo saying what it is for', async () => {
    const spend = jest.fn().mockResolvedValue({ hash: 'th_milestone_1' });
    const rewardAccount = { address: 'ak_rewards' };
    const rewardRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }),
      create: jest.fn().mockImplementation((v) => v),
      save: jest.fn().mockImplementation(async (v) => v),
    };
    const milestoneRewardRepository = {
      save: jest.fn().mockImplementation(async (v) => v),
    };
    const service = new ProfileXInviteService(
      {} as any,
      {} as any,
      {} as any,
      milestoneRewardRepository as any,
      { sdk: { spend } } as any,
      {
        enqueueSpend: jest.fn().mockImplementation(async (_k, work) => work()),
        getRewardAccount: jest.fn().mockReturnValue(rewardAccount),
      } as any,
      {
        transaction: jest
          .fn()
          .mockImplementation(async (cb) =>
            cb({ getRepository: () => rewardRepo }),
          ),
      } as any,
    );

    await (service as any).sendMilestoneRewardIfEligible('ak_inviter');

    expect(spend).toHaveBeenCalledTimes(1);
    const [amount, recipient, options] = spend.mock.calls[0];
    expect(amount).toBe('20000000000000000'); // 0.02 AE
    expect(recipient).toBe('ak_inviter');
    expect(options.onAccount).toBe(rewardAccount);
    expect(decode(options.payload).toString()).toBe(
      'Superhero X reward: 10 invites',
    );
    expect(milestoneRewardRepository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'paid', tx_hash: 'th_milestone_1' }),
    );
  });
});

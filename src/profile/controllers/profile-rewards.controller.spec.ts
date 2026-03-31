import { ProfileRewardsController } from './profile-rewards.controller';

describe('ProfileRewardsController', () => {
  const getController = (overrides?: {
    profileXInviteService?: any;
    profileXPostingRewardService?: any;
  }) => {
    const profileXInviteService =
      overrides?.profileXInviteService || ({} as any);
    const profileXPostingRewardService =
      overrides?.profileXPostingRewardService || ({} as any);
    const controller = new ProfileRewardsController(
      profileXInviteService,
      profileXPostingRewardService,
    );
    return { controller, profileXInviteService, profileXPostingRewardService };
  };

  it('gets x posting reward status', async () => {
    const profileXPostingRewardService = {
      getRewardStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
    } as any;
    const { controller } = getController({ profileXPostingRewardService });

    await controller.getXPostingRewardStatus('ak_1');

    expect(profileXPostingRewardService.getRewardStatus).toHaveBeenCalledWith(
      'ak_1',
    );
  });

  it('creates a posting reward recheck challenge', async () => {
    const profileXInviteService = {
      createPostingRewardRecheckChallenge: jest
        .fn()
        .mockResolvedValue({ nonce: 'n' }),
    } as any;
    const { controller } = getController({ profileXInviteService });

    await controller.createXPostingRewardRecheckChallenge({
      address: 'ak_1',
    } as any);

    expect(
      profileXInviteService.createPostingRewardRecheckChallenge,
    ).toHaveBeenCalledWith('ak_1');
  });

  it('verifies challenge proof before running manual recheck', async () => {
    const profileXInviteService = {
      verifyPostingRewardRecheckChallenge: jest
        .fn()
        .mockResolvedValue(undefined),
    } as any;
    const profileXPostingRewardService = {
      requestManualRecheck: jest.fn().mockResolvedValue({ status: 'pending' }),
    } as any;
    const { controller } = getController({
      profileXInviteService,
      profileXPostingRewardService,
    });

    await controller.recheckXPostingReward('ak_1', {
      challenge_nonce: 'a'.repeat(24),
      challenge_expires_at: '123',
      signature_hex: 'b'.repeat(128),
    } as any);

    expect(
      profileXInviteService.verifyPostingRewardRecheckChallenge,
    ).toHaveBeenCalledWith({
      address: 'ak_1',
      nonce: 'a'.repeat(24),
      expiresAt: 123,
      signatureHex: 'b'.repeat(128),
    });
    expect(
      profileXPostingRewardService.requestManualRecheck,
    ).toHaveBeenCalledWith('ak_1');
  });
});

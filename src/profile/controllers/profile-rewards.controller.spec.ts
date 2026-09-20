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
      refreshInBackgroundIfDue: jest.fn().mockResolvedValue(undefined),
    } as any;
    const { controller } = getController({ profileXPostingRewardService });

    await controller.getXPostingRewardStatus('ak_1');

    expect(profileXPostingRewardService.getRewardStatus).toHaveBeenCalledWith(
      'ak_1',
    );
  });

  it('starts a background refresh on a status read, without waiting for it', async () => {
    // Reading the page is what starts a due check now, since nothing runs on a
    // schedule. It must not delay the response, so this asserts the status
    // resolves while the refresh is still pending.
    let releaseRefresh: (() => void) | null = null;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const profileXPostingRewardService = {
      getRewardStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
      refreshInBackgroundIfDue: jest
        .fn()
        .mockImplementation(() => refreshStarted),
    } as any;
    const { controller } = getController({ profileXPostingRewardService });

    const result = await controller.getXPostingRewardStatus('ak_1');

    expect(
      profileXPostingRewardService.refreshInBackgroundIfDue,
    ).toHaveBeenCalledWith('ak_1');
    expect(result).toEqual({ status: 'pending' });
    releaseRefresh?.();
  });

  it('still returns the status when the background refresh rejects', async () => {
    // A refresh that blew up must never turn a page load into an error. The
    // service swallows its own failures; this covers that guarantee being
    // removed or a future refresh implementation forgetting it.
    const profileXPostingRewardService = {
      getRewardStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
      refreshInBackgroundIfDue: jest
        .fn()
        .mockRejectedValue(new Error('refresh exploded')),
    } as any;
    const { controller } = getController({ profileXPostingRewardService });

    await expect(controller.getXPostingRewardStatus('ak_1')).resolves.toEqual({
      status: 'pending',
    });
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

  it('verifies challenge proof before minting a referral link', async () => {
    const profileXInviteService = {
      verifyPostingRewardRecheckChallenge: jest
        .fn()
        .mockResolvedValue(undefined),
    } as any;
    const profileXPostingRewardService = {
      getOrCreateReferralLink: jest.fn().mockResolvedValue({
        code: 'abc123def456',
        link: 'https://x/r?ref=abc123def456',
      }),
    } as any;
    const { controller } = getController({
      profileXInviteService,
      profileXPostingRewardService,
    });

    const result = await controller.createXRewardReferralLink('ak_1', {
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
      profileXPostingRewardService.getOrCreateReferralLink,
    ).toHaveBeenCalledWith('ak_1');
    expect(result.code).toBe('abc123def456');
  });

  it('does NOT run the recheck when challenge verification fails', async () => {
    const profileXInviteService = {
      verifyPostingRewardRecheckChallenge: jest
        .fn()
        .mockRejectedValue(new Error('bad signature')),
    } as any;
    const profileXPostingRewardService = {
      requestManualRecheck: jest.fn(),
    } as any;
    const { controller } = getController({
      profileXInviteService,
      profileXPostingRewardService,
    });

    await expect(
      controller.recheckXPostingReward('ak_1', {
        challenge_nonce: 'a'.repeat(24),
        challenge_expires_at: '123',
        signature_hex: 'b'.repeat(128),
      } as any),
    ).rejects.toThrow('bad signature');

    // The signature gate must hold: no recheck runs without a valid proof.
    expect(
      profileXPostingRewardService.requestManualRecheck,
    ).not.toHaveBeenCalled();
  });

  it('does NOT mint a referral link when challenge verification fails', async () => {
    const profileXInviteService = {
      verifyPostingRewardRecheckChallenge: jest
        .fn()
        .mockRejectedValue(new Error('bad signature')),
    } as any;
    const profileXPostingRewardService = {
      getOrCreateReferralLink: jest.fn(),
    } as any;
    const { controller } = getController({
      profileXInviteService,
      profileXPostingRewardService,
    });

    await expect(
      controller.createXRewardReferralLink('ak_1', {
        challenge_nonce: 'a'.repeat(24),
        challenge_expires_at: '123',
        signature_hex: 'b'.repeat(128),
      } as any),
    ).rejects.toThrow('bad signature');

    expect(
      profileXPostingRewardService.getOrCreateReferralLink,
    ).not.toHaveBeenCalled();
  });
});

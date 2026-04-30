import { ProfileController } from './profile.controller';

describe('ProfileController', () => {
  const validAddress1 = 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo';
  const validAddress2 = 'ak_2maNN7AsevCiv546m1TLrSxCFSDeVHif7S7pSsdPS2VXEbkbG';

  const getController = (overrides?: {
    profileXInviteService?: any;
    profileXVerificationRewardService?: any;
    profileXPostingRewardService?: any;
    invitationRepository?: any;
  }) => {
    const profileXInviteService =
      overrides?.profileXInviteService || ({} as any);
    const profileXVerificationRewardService =
      overrides?.profileXVerificationRewardService || ({} as any);
    const profileXPostingRewardService =
      overrides?.profileXPostingRewardService || ({} as any);
    const invitationRepository =
      overrides?.invitationRepository ||
      ({
        count: jest.fn().mockResolvedValue(0),
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
        }),
      } as any);
    const profileReadService = {
      getProfilesByAddresses: jest.fn().mockResolvedValue([]),
    } as any;
    const profileAttestationService = {} as any;
    const controller = new ProfileController(
      profileAttestationService,
      profileReadService,
      profileXInviteService,
      profileXVerificationRewardService,
      profileXPostingRewardService,
      invitationRepository,
    );
    return { controller, profileReadService };
  };

  it('parses addresses query for batch endpoint', async () => {
    const { controller, profileReadService } = getController();

    await controller.getProfiles(`${validAddress1}, ${validAddress2}`, 'false');

    expect(profileReadService.getProfilesByAddresses).toHaveBeenCalledWith(
      [validAddress1, validAddress2],
      { includeOnChain: false },
    );
  });

  it('creates invite and returns generated link payload', async () => {
    const profileXInviteService = {
      createInvite: jest
        .fn()
        .mockResolvedValue({ code: 'abc', invite_link: 'abc' }),
    } as any;
    const { controller } = getController({ profileXInviteService });

    await controller.createXInvite({
      inviter_address: 'ak_1',
      challenge_nonce: 'a'.repeat(24),
      challenge_expires_at: '123',
      signature_hex: 'b'.repeat(128),
    } as any);

    expect(profileXInviteService.createInvite).toHaveBeenCalledWith({
      inviterAddress: 'ak_1',
      challengeNonce: 'a'.repeat(24),
      challengeExpiresAt: 123,
      signatureHex: 'b'.repeat(128),
    });
  });

  it('binds invite with challenge proof payload', async () => {
    const profileXInviteService = {
      bindInvite: jest.fn().mockResolvedValue({ status: 'bound' }),
    } as any;
    const { controller } = getController({ profileXInviteService });

    await controller.bindXInvite('abc123def456', {
      invitee_address: 'ak_2',
      challenge_nonce: 'c'.repeat(24),
      challenge_expires_at: '456',
      signature_hex: 'd'.repeat(128),
    } as any);

    expect(profileXInviteService.bindInvite).toHaveBeenCalledWith({
      code: 'abc123def456',
      inviteeAddress: 'ak_2',
      challengeNonce: 'c'.repeat(24),
      challengeExpiresAt: 456,
      signatureHex: 'd'.repeat(128),
    });
  });

  it('creates invite challenge', async () => {
    const profileXInviteService = {
      createChallenge: jest.fn().mockResolvedValue({ nonce: 'n' }),
    } as any;
    const { controller } = getController({ profileXInviteService });

    await controller.createXInviteChallenge({
      address: 'ak_2',
      purpose: 'bind',
      code: 'abc123def456',
    } as any);

    expect(profileXInviteService.createChallenge).toHaveBeenCalledWith({
      address: 'ak_2',
      purpose: 'bind',
      code: 'abc123def456',
    });
  });

  it('gets invite progress', async () => {
    const profileXInviteService = {
      getProgress: jest.fn().mockResolvedValue({ verified_friends_count: 1 }),
    } as any;
    const { controller } = getController({ profileXInviteService });

    await controller.getXInviteProgress('ak_2');
    expect(profileXInviteService.getProgress).toHaveBeenCalledWith('ak_2');
  });

  it('gets combined rewards progress', async () => {
    const profileXInviteService = {
      getProgress: jest.fn().mockResolvedValue({ verified_friends_count: 3 }),
    } as any;
    const profileXVerificationRewardService = {
      getRewardStatus: jest.fn().mockResolvedValue({ status: 'paid' }),
    } as any;
    const profileXPostingRewardService = {
      getRewardStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
    } as any;
    const invitationRepository = {
      count: jest
        .fn()
        .mockResolvedValueOnce(12)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(3),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: '42.5' }),
      }),
    } as any;
    const { controller } = getController({
      profileXInviteService,
      profileXVerificationRewardService,
      profileXPostingRewardService,
      invitationRepository,
    });

    const result = await controller.getRewardsProgress('ak_2');
    expect(
      profileXVerificationRewardService.getRewardStatus,
    ).toHaveBeenCalledWith('ak_2');
    expect(profileXPostingRewardService.getRewardStatus).toHaveBeenCalledWith(
      'ak_2',
    );
    expect(profileXInviteService.getProgress).toHaveBeenCalledWith('ak_2');
    expect(result).toEqual({
      address: 'ak_2',
      x_verification_reward: { status: 'paid' },
      x_posting_reward: { status: 'pending' },
      x_invite_reward: { verified_friends_count: 3 },
      affiliation: {
        as_inviter: {
          total_invitations: 12,
          claimed_invitations: 5,
          revoked_invitations: 2,
          pending_invitations: 5,
          total_amount_ae: 42.5,
        },
        as_invitee: {
          total_received_invitations: 4,
          claimed_received_invitations: 3,
        },
      },
    });
  });
});

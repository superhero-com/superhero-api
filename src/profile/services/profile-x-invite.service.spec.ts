jest.mock('../profile.constants', () => ({
  PROFILE_X_INVITE_LINK_BASE_URL: 'https://example.app/invite',
  PROFILE_X_INVITE_CHALLENGE_TTL_SECONDS: 300,
  PROFILE_X_INVITE_MILESTONE_REWARD_AMOUNT_AE: '0.02',
  PROFILE_X_INVITE_MILESTONE_REWARD_PRIVATE_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
  PROFILE_X_INVITE_MILESTONE_THRESHOLD: 10,
  PROFILE_X_INVITE_PENDING_TIMEOUT_SECONDS: 300,
}));

import { ProfileXInviteService } from './profile-x-invite.service';
import * as profileSignatureUtil from './profile-signature.util';

describe.skip('ProfileXInviteService', () => {
  const getService = () => {
    const inviteRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(async (v) => v),
      create: jest.fn().mockImplementation((v) => v),
    } as any;
    const inviteChallengeRepository = {
      save: jest.fn().mockImplementation(async (v) => v),
      create: jest.fn().mockImplementation((v) => v),
    } as any;
    const inviteCreditInsertBuilder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
    };
    const inviteCreditRepository = {
      count: jest.fn().mockResolvedValue(10),
      createQueryBuilder: jest.fn().mockReturnValue(inviteCreditInsertBuilder),
    } as any;
    const milestoneRewardRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ status: 'pending', tx_hash: null }),
      save: jest.fn().mockImplementation(async (v) => v),
      create: jest.fn().mockImplementation((v) => v),
    } as any;
    const aeSdkService = {
      sdk: {
        spend: jest.fn().mockResolvedValue({ hash: 'th_milestone_1' }),
      },
    } as any;
    const profileSpendQueueService = {
      enqueueSpend: jest.fn().mockImplementation(async (_k, work) => work()),
      getRewardAccount: jest.fn().mockReturnValue({}),
    } as any;
    const manager = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        }),
        create: jest.fn().mockImplementation((v) => v),
        save: jest.fn().mockImplementation(async (v) => v),
      }),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
    } as any;

    const service = new ProfileXInviteService(
      inviteRepository,
      inviteChallengeRepository,
      inviteCreditRepository,
      milestoneRewardRepository,
      aeSdkService,
      profileSpendQueueService,
      dataSource,
    );

    return {
      service,
      inviteRepository,
      inviteChallengeRepository,
      inviteCreditRepository,
      inviteCreditInsertBuilder,
      milestoneRewardRepository,
      profileSpendQueueService,
      aeSdkService,
      manager,
      dataSource,
    };
  };

  it('creates challenge with message and nonce', async () => {
    const { service, inviteChallengeRepository } = getService();

    const result = await service.createChallenge({
      address: 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
      purpose: 'create',
    });

    expect(result.nonce).toBeTruthy();
    expect(result.message).toContain('profile_x_invite:create:');
    expect(inviteChallengeRepository.save).toHaveBeenCalledTimes(1);
  });

  it('creates posting reward recheck challenge through existing bind challenge storage', async () => {
    const { service, inviteChallengeRepository } = getService();

    const result = await service.createPostingRewardRecheckChallenge(
      'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
    );

    expect(result.nonce).toBeTruthy();
    expect(result.message).toContain('profile_x_invite:bind:');
    expect(inviteChallengeRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'bind',
        invite_code: 'recheck00001',
      }),
    );
  });

  it('creates invite after challenge verification', async () => {
    const { service, inviteRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    inviteRepository.findOne.mockResolvedValue(null);

    const result = await service.createInvite({
      inviterAddress: 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
      challengeNonce: 'a'.repeat(24),
      challengeExpiresAt: Date.now() + 10_000,
      signatureHex: 'b'.repeat(128),
    });

    expect(result.code).toHaveLength(12);
    expect(result.invite_link).toContain('?xInvite=');
    expect(inviteRepository.save).toHaveBeenCalledTimes(1);
  });

  it('retries invite creation when a concurrent code collision happens on save', async () => {
    const { service, inviteRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'generateUniqueCode')
      .mockResolvedValueOnce('abc123def456')
      .mockResolvedValueOnce('def456abc123');
    inviteRepository.save
      .mockRejectedValueOnce({
        driverError: {
          code: '23505',
          constraint: 'uq_profile_x_invites_code',
        },
      })
      .mockImplementation(async (value) => value);

    const result = await service.createInvite({
      inviterAddress: 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
      challengeNonce: 'a'.repeat(24),
      challengeExpiresAt: Date.now() + 10_000,
      signatureHex: 'b'.repeat(128),
    });

    expect(inviteRepository.save).toHaveBeenCalledTimes(2);
    expect(result.code).toBe('def456abc123');
  });

  it('rejects malformed invite code on bind', async () => {
    const { service } = getService();

    await expect(
      service.bindInvite({
        code: 'bad-code',
        inviteeAddress: 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('Invalid invite code format');
  });

  it('creates one credit and triggers milestone reward spend once', async () => {
    const {
      service,
      inviteRepository,
      inviteCreditInsertBuilder,
      aeSdkService,
    } = getService();
    inviteRepository.findOne.mockResolvedValue({
      code: 'abc123def456',
      inviter_address: 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
      invitee_address: 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      status: 'bound',
    });

    await service.processInviteeXVerified(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
    );
    inviteCreditInsertBuilder.execute.mockResolvedValueOnce({
      identifiers: [],
    });
    await service.processInviteeXVerified(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
    );

    expect(aeSdkService.sdk.spend).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue milestone payout when a fresh pending reward already exists', async () => {
    const {
      service,
      inviteRepository,
      inviteCreditInsertBuilder,
      aeSdkService,
      manager,
    } = getService();
    inviteRepository.findOne.mockResolvedValue({
      code: 'abc123def456',
      inviter_address: 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
      invitee_address: 'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
      status: 'bound',
    });
    manager.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          inviter_address:
            'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
          threshold: 10,
          status: 'pending',
          tx_hash: null,
          updated_at: new Date(),
        }),
      }),
      create: jest.fn().mockImplementation((v) => v),
      save: jest.fn().mockImplementation(async (v) => v),
    });

    await service.processInviteeXVerified(
      'ak_2EZDUTjrzPUikzNereYcBHMYHXaLTn9F6SJJhw6kDEiP4F4Amo',
    );

    expect(inviteCreditInsertBuilder.execute).toHaveBeenCalledTimes(1);
    expect(aeSdkService.sdk.spend).not.toHaveBeenCalled();
  });

  it('preserves sg_ signature casing during challenge verification', async () => {
    const { service, manager, dataSource } = getService();
    const challenge = {
      address: 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
      purpose: 'create',
      invite_code: '',
      nonce: 'a'.repeat(24),
      expires_at: Date.now() + 10_000,
      consumed_at: null,
    };
    const save = jest.fn().mockImplementation(async (v) => v);
    manager.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(challenge),
      }),
      save,
    });
    const verifyAddressSignature = jest
      .spyOn(profileSignatureUtil, 'verifyAeAddressSignature')
      .mockReturnValue(true);

    const signatureHex = 'sg_AbCdEfGhJkLmNoPqRsTuVwXyZ123456789';

    await (service as any).verifyAndConsumeChallenge({
      address: challenge.address,
      purpose: 'create',
      inviteCode: null,
      nonce: challenge.nonce,
      expiresAt: challenge.expires_at,
      signatureHex,
    });

    expect(verifyAddressSignature).toHaveBeenCalledWith(
      challenge.address,
      expect.any(String),
      signatureHex,
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        consumed_at: expect.any(Date),
      }),
    );
    expect(dataSource.transaction).toHaveBeenCalled();
  });

  it('returns inviter progress payload', async () => {
    const { service, inviteCreditRepository } = getService();
    inviteCreditRepository.count.mockResolvedValue(4);

    const progress = await service.getProgress(
      'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
    );
    expect(progress).toEqual({
      inviter_address: 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s',
      verified_friends_count: 4,
      goal: 10,
      remaining_to_goal: 6,
      milestone_reward_status: 'pending',
      milestone_reward_tx_hash: null,
    });
  });
});

jest.mock('../profile.constants', () => ({
  PROFILE_CHAIN_NAME_PRIVATE_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
  PROFILE_CHAIN_NAME_CHALLENGE_TTL_SECONDS: 300,
  PROFILE_CHAIN_NAME_RETRY_BASE_SECONDS: 30,
  PROFILE_CHAIN_NAME_RETRY_MAX_SECONDS: 3600,
  PROFILE_CHAIN_NAME_MAX_RETRIES: 10,
}));

jest.mock('@aeternity/aepp-sdk', () => {
  const actual = jest.requireActual('@aeternity/aepp-sdk');
  return {
    ...actual,
    buildTxAsync: jest.fn(),
    sendTransaction: jest.fn(),
    verifyMessageSignature: jest.fn().mockReturnValue(true),
    decode: jest.fn(),
    isEncoded: jest.fn().mockReturnValue(true),
  };
});

import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  buildTxAsync,
  sendTransaction,
  Tag,
  verifyMessageSignature,
} from '@aeternity/aepp-sdk';
import { ProfileChainNameService } from './profile-chain-name.service';
import { ProfileChainNameClaim } from '../entities/profile-chain-name-claim.entity';
import { ProfileChainNameChallenge } from '../entities/profile-chain-name-challenge.entity';

describe('ProfileChainNameService', () => {
  const validAddress = 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s';

  const getService = () => {
    const claimRepository = {
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockImplementation(async (value) => value),
      create: jest.fn().mockImplementation((value) => value),
    } as any;
    const challengeRepository = {
      save: jest.fn().mockImplementation(async (value) => value),
      create: jest.fn().mockImplementation((value) => value),
    } as any;
    const lockedClaimRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }),
      save: jest.fn().mockImplementation(async (value) => value),
    } as any;
    const lockedChallengeRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }),
      save: jest.fn().mockImplementation(async (value) => value),
    } as any;
    const manager = {
      getRepository: jest.fn().mockImplementation((entity) => {
        if (entity === ProfileChainNameChallenge)
          return lockedChallengeRepository;
        if (entity === ProfileChainNameClaim) return lockedClaimRepository;
        return null;
      }),
    };
    const dataSource = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(manager)),
    } as any;
    const aeSdkService = {
      sdk: {
        getContext: jest.fn().mockReturnValue({ onNode: {} }),
        getHeight: jest.fn().mockResolvedValue(100),
        getBalance: jest.fn().mockResolvedValue('100000000000000000000'),
      },
    } as any;
    const profileSpendQueueService = {
      enqueueSpend: jest.fn().mockImplementation(async (_key, work) => work()),
      getRewardAccount: jest.fn().mockReturnValue({ address: validAddress }),
    } as any;

    const service = new ProfileChainNameService(
      claimRepository,
      challengeRepository,
      dataSource,
      aeSdkService,
      profileSpendQueueService,
    );

    return {
      service,
      claimRepository,
      challengeRepository,
      lockedClaimRepository,
      lockedChallengeRepository,
      dataSource,
      aeSdkService,
      profileSpendQueueService,
    };
  };

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('creates a wallet challenge with a signed message payload', async () => {
    const { service, challengeRepository } = getService();

    const result = await service.createChallenge(validAddress);

    expect(result.nonce).toBeTruthy();
    expect(result.message).toContain(
      `profile_chain_name_claim:${validAddress}:`,
    );
    expect(challengeRepository.save).toHaveBeenCalledTimes(1);
  });

  it('treats the same in-flight name request as idempotent', async () => {
    const { service, claimRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    const fundsSpy = jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockRejectedValue(new ServiceUnavailableException('no funds'));
    const processSpy = jest
      .spyOn(service as any, 'processClaimWithGuard')
      .mockResolvedValue(undefined);
    claimRepository.findOne.mockResolvedValueOnce({
      address: validAddress,
      name: 'myuniquename123.chain',
      status: 'pending',
    });

    const result = await service.requestChainName({
      address: validAddress,
      name: 'myuniquename123',
      challengeNonce: 'a'.repeat(24),
      challengeExpiresAt: Date.now() + 10_000,
      signatureHex: 'b'.repeat(128),
    });

    expect(result.status).toBe('pending');
    expect(claimRepository.save).not.toHaveBeenCalled();
    expect(fundsSpy).not.toHaveBeenCalled();
    expect(processSpy).toHaveBeenCalledWith(validAddress);
  });

  it('does not consume the challenge when sponsor funds are insufficient', async () => {
    const { service } = getService();
    const verifySpy = jest.spyOn(service as any, 'verifyAndConsumeChallenge');
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockRejectedValue(
        new ServiceUnavailableException(
          'Chain name claiming is temporarily unavailable due to insufficient sponsor funds',
        ),
      );

    await expect(
      service.requestChainName({
        address: validAddress,
        name: 'myuniquename123',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('rejects a second completed sponsored name for the same address', async () => {
    const { service, claimRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    claimRepository.findOne.mockResolvedValueOnce({
      address: validAddress,
      name: 'claimedname123.chain',
      status: 'completed',
    });

    await expect(
      service.requestChainName({
        address: validAddress,
        name: 'myuniquename123',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects a different in-progress name for the same address', async () => {
    const { service, claimRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    claimRepository.findOne.mockResolvedValueOnce({
      address: validAddress,
      name: 'anothername123.chain',
      status: 'preclaimed',
    });

    await expect(
      service.requestChainName({
        address: validAddress,
        name: 'myuniquename123',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('Address already has an in-progress chain name claim');
  });

  it('rejects a name already being actively claimed by another address', async () => {
    const { service, claimRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    claimRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      address: 'ak_other',
      name: 'myuniquename123.chain',
      status: 'preclaimed',
    });

    await expect(
      service.requestChainName({
        address: validAddress,
        name: 'myuniquename123',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('This name is already being claimed by another address');
  });

  it('allows reusing a name from another address when its old claim failed', async () => {
    const { service, claimRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getNameStateIfPresent').mockResolvedValue(null);
    jest
      .spyOn(service as any, 'processClaimWithGuard')
      .mockResolvedValue(undefined);
    claimRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      address: 'ak_other',
      name: 'myuniquename123.chain',
      status: 'failed',
    });

    const result = await service.requestChainName({
      address: validAddress,
      name: 'myuniquename123',
      challengeNonce: 'a'.repeat(24),
      challengeExpiresAt: Date.now() + 10_000,
      signatureHex: 'b'.repeat(128),
    });

    expect(result.status).toBe('ok');
    expect(claimRepository.delete).toHaveBeenCalledWith({
      address: 'ak_other',
    });
    expect(claimRepository.save).toHaveBeenCalled();
  });

  it('rejects a name already taken on-chain by someone else', async () => {
    const { service, claimRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'getNameStateIfPresent')
      .mockResolvedValue({ owner: 'ak_someone_else' });
    claimRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(
      service.requestChainName({
        address: validAddress,
        name: 'myuniquename123',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('This name is already taken on-chain');
  });

  it('converts unique constraint races into a conflict error', async () => {
    const { service, claimRepository } = getService();
    jest
      .spyOn(service as any, 'verifyAndConsumeChallenge')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getNameStateIfPresent').mockResolvedValue(null);
    claimRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    claimRepository.save.mockRejectedValueOnce({
      driverError: { code: '23505' },
    });

    await expect(
      service.requestChainName({
        address: validAddress,
        name: 'myuniquename123',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('This name is already being claimed by another address');
  });

  it('builds a name claim tx using the persisted salt value', async () => {
    const { service } = getService();
    (buildTxAsync as jest.Mock).mockResolvedValue('tx_unsigned');
    (sendTransaction as jest.Mock).mockResolvedValue({ hash: 'th_claim_1' });

    await (service as any).submitClaimTransaction(
      'myuniquename123.chain',
      '123456789',
    );

    expect(buildTxAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: Tag.NameClaimTx,
        name: 'myuniquename123.chain',
        nameSalt: 123456789,
      }),
    );
    expect(sendTransaction).toHaveBeenCalledWith(
      'tx_unsigned',
      expect.objectContaining({
        onAccount: expect.any(Object),
      }),
    );
  });

  it('rejects an invalid persisted salt before building the claim tx', async () => {
    const { service } = getService();

    await expect(
      (service as any).submitClaimTransaction(
        'myuniquename123.chain',
        'not-a-number',
      ),
    ).rejects.toThrow('Invalid persisted name salt');

    expect(buildTxAsync).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('consumes a matching signature challenge', async () => {
    const { service, dataSource } = getService();
    const challenge = {
      nonce: 'a'.repeat(24),
      address: validAddress,
      expires_at: new Date(Date.now() + 10_000),
      consumed_at: null,
    };
    const challengeRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(challenge),
      }),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    dataSource.transaction.mockImplementation(async (cb) =>
      cb({
        getRepository: jest.fn().mockReturnValue(challengeRepo),
      }),
    );

    await (service as any).verifyAndConsumeChallenge({
      address: validAddress,
      nonce: challenge.nonce,
      expiresAt: challenge.expires_at.getTime(),
      signatureHex: 'b'.repeat(128),
    });

    expect(verifyMessageSignature).toHaveBeenCalled();
    expect(challengeRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        consumed_at: expect.any(Date),
      }),
    );
  });

  it('rejects challenge verification when proof fields are missing', async () => {
    const { service } = getService();

    await expect(
      (service as any).verifyAndConsumeChallenge({
        address: validAddress,
        nonce: '',
        expiresAt: 0,
        signatureHex: '',
      }),
    ).rejects.toThrow('Challenge proof is required');
  });

  it('rejects challenge verification when challenge is not found', async () => {
    const { service, dataSource } = getService();
    const challengeRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }),
    };
    dataSource.transaction.mockImplementation(async (cb) =>
      cb({
        getRepository: jest.fn().mockReturnValue(challengeRepo),
      }),
    );

    await expect(
      (service as any).verifyAndConsumeChallenge({
        address: validAddress,
        nonce: 'a'.repeat(24),
        expiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('Challenge not found');
  });

  it('rejects challenge verification on expiry mismatch', async () => {
    const { service, dataSource } = getService();
    const challenge = {
      nonce: 'a'.repeat(24),
      address: validAddress,
      expires_at: new Date(Date.now() + 20_000),
      consumed_at: null,
    };
    const challengeRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(challenge),
      }),
    };
    dataSource.transaction.mockImplementation(async (cb) =>
      cb({
        getRepository: jest.fn().mockReturnValue(challengeRepo),
      }),
    );

    await expect(
      (service as any).verifyAndConsumeChallenge({
        address: validAddress,
        nonce: challenge.nonce,
        expiresAt: challenge.expires_at.getTime() - 1,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('Challenge expiry mismatch');
  });

  it('rejects challenge verification on invalid signature', async () => {
    const { service, dataSource } = getService();
    const challenge = {
      nonce: 'a'.repeat(24),
      address: validAddress,
      expires_at: new Date(Date.now() + 10_000),
      consumed_at: null,
    };
    const challengeRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(challenge),
      }),
    };
    dataSource.transaction.mockImplementation(async (cb) =>
      cb({
        getRepository: jest.fn().mockReturnValue(challengeRepo),
      }),
    );
    jest.spyOn(service as any, 'verifyAddressSignature').mockReturnValue(false);

    await expect(
      (service as any).verifyAndConsumeChallenge({
        address: validAddress,
        nonce: challenge.nonce,
        expiresAt: challenge.expires_at.getTime(),
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('Invalid challenge signature');
  });

  it('marks retry when processing cannot continue because sponsor funds are unavailable', async () => {
    const { service } = getService();
    const markRetrySpy = jest
      .spyOn(service as any, 'markRetry')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'withLockedClaim').mockResolvedValue({
      address: validAddress,
      name: 'myuniquename123.chain',
      status: 'pending',
    });
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockRejectedValue(new ServiceUnavailableException('no funds'));

    await (service as any).processClaimInternal(validAddress);

    expect(markRetrySpy).toHaveBeenCalledWith(
      validAddress,
      'Sponsor account has insufficient funds',
    );
  });

  it('resets an expired preclaim back to pending', async () => {
    const { service, claimRepository, aeSdkService } = getService();
    const save = jest.fn().mockResolvedValue(undefined);
    const entry = {
      address: validAddress,
      name: 'myuniquename123.chain',
      status: 'preclaimed',
      salt: '123',
      preclaim_height: 1,
      preclaim_tx_hash: 'th_preclaim',
      error: 'old',
      retry_count: 5,
      next_retry_at: null,
    };
    claimRepository.findOne.mockResolvedValue(entry);
    aeSdkService.sdk.getHeight.mockResolvedValue(1000);
    jest.spyOn(service as any, 'getNameStateIfPresent').mockResolvedValue(null);
    jest
      .spyOn(service as any, 'withLockedClaim')
      .mockImplementation(async (_address, work) =>
        (work as any)({ save } as any, entry),
      );

    await (service as any).stepClaim(validAddress);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        salt: null,
        preclaim_height: null,
        preclaim_tx_hash: null,
        retry_count: 0,
      }),
    );
  });

  it('waits for the next height before claiming after preclaim', async () => {
    const { service, claimRepository, aeSdkService, profileSpendQueueService } =
      getService();
    const save = jest.fn().mockResolvedValue(undefined);
    const entry = {
      address: validAddress,
      name: 'myuniquename123.chain',
      status: 'preclaimed',
      salt: '123',
      preclaim_height: 100,
      next_retry_at: null,
    };
    claimRepository.findOne.mockResolvedValue(entry);
    aeSdkService.sdk.getHeight.mockResolvedValue(100);
    jest.spyOn(service as any, 'getNameStateIfPresent').mockResolvedValue(null);
    jest
      .spyOn(service as any, 'withLockedClaim')
      .mockImplementation(async (_address, work) =>
        (work as any)({ save } as any, entry),
      );

    await (service as any).stepClaim(validAddress);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        next_retry_at: expect.any(Date),
      }),
    );
    expect(profileSpendQueueService.enqueueSpend).not.toHaveBeenCalled();
  });

  it('marks a claim complete when the name is already owned by the user', async () => {
    const { service, claimRepository } = getService();
    const save = jest.fn().mockResolvedValue(undefined);
    const entry = {
      address: validAddress,
      name: 'myuniquename123.chain',
      status: 'claimed',
      next_retry_at: new Date(),
    };
    claimRepository.findOne.mockResolvedValue(entry);
    jest
      .spyOn(service as any, 'getNameStateIfPresent')
      .mockResolvedValue({ owner: validAddress });
    jest
      .spyOn(service as any, 'withLockedClaim')
      .mockImplementation(async (_address, work) =>
        (work as any)({ save } as any, entry),
      );

    await (service as any).stepUpdatePointer(validAddress);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        next_retry_at: null,
      }),
    );
  });

  it('marks a claim failed once max retries is reached', async () => {
    const { service } = getService();
    const save = jest.fn().mockResolvedValue(undefined);
    const entry = {
      address: validAddress,
      status: 'pending',
      retry_count: 9,
      next_retry_at: new Date(),
      error: null,
    };
    jest
      .spyOn(service as any, 'withLockedClaim')
      .mockImplementation(async (_address, work) =>
        (work as any)({ save } as any, entry),
      );

    await (service as any).markRetry(validAddress, 'boom');

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        retry_count: 10,
        error: 'boom',
        next_retry_at: null,
      }),
    );
  });
});

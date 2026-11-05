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

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  buildTxAsync,
  sendTransaction,
  Tag,
  TxTimedOutError,
  verifyMessageSignature,
} from '@aeternity/aepp-sdk';
import { PROFILE_CHAIN_NAME_PRIVATE_KEY } from '../profile.constants';
import { ProfileChainNameService } from './profile-chain-name.service';
import * as profileSignatureUtil from './profile-signature.util';
import { ProfileChainNameClaim } from '../entities/profile-chain-name-claim.entity';
import { ProfileChainNameChallenge } from '../entities/profile-chain-name-challenge.entity';

describe('ProfileChainNameService', () => {
  const validAddress = 'ak_2A9A8vXrX3tQzN5xW1TfFjBgfDkJtN2gQq7mB7cDgY7xT2R9s';

  const getService = () => {
    const claimRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
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
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
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

  it('reports sponsorable when the sponsor balance covers the claim cost', async () => {
    const { service, aeSdkService } = getService();
    jest.spyOn(service as any, 'estimateTotalClaimCost').mockReturnValue(1000n);
    aeSdkService.sdk.getBalance.mockResolvedValue('5000');

    const result = await service.checkNameSponsorship('myuniquename123');

    expect(result).toEqual({
      name: 'myuniquename123.chain',
      sponsorable: true,
      sponsor_configured: true,
      sponsor_balance_aettos: '5000',
      required_balance_aettos: '1000',
      reason: null,
    });
  });

  it('reports not sponsorable when the sponsor balance is too low', async () => {
    const { service, aeSdkService } = getService();
    jest.spyOn(service as any, 'estimateTotalClaimCost').mockReturnValue(1000n);
    aeSdkService.sdk.getBalance.mockResolvedValue('500');

    const result = await service.checkNameSponsorship('myuniquename123');

    expect(result.sponsorable).toBe(false);
    expect(result.reason).toBe('Insufficient sponsor funds');
    expect(result.sponsor_balance_aettos).toBe('500');
    expect(result.required_balance_aettos).toBe('1000');
  });

  it('reports not sponsorable when the sponsor balance cannot be fetched', async () => {
    const { service, aeSdkService } = getService();
    jest.spyOn(service as any, 'estimateTotalClaimCost').mockReturnValue(1000n);
    aeSdkService.sdk.getBalance.mockRejectedValue(new Error('node down'));

    const result = await service.checkNameSponsorship('myuniquename123');

    expect(result.sponsorable).toBe(false);
    expect(result.sponsor_balance_aettos).toBeNull();
    expect(result.reason).toBe('Unable to verify sponsor balance');
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
    const verifySpy = jest.spyOn(service as any, 'verifyAndConsumeChallenge');
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

    expect(verifySpy).not.toHaveBeenCalled();
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
    const verifySpy = jest.spyOn(service as any, 'verifyAndConsumeChallenge');
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

    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('allows reusing a name from another address when its old claim failed', async () => {
    const {
      service,
      claimRepository,
      lockedClaimRepository,
      lockedChallengeRepository,
      dataSource,
    } = getService();
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getNameStateIfPresent').mockResolvedValue(null);
    jest
      .spyOn(service as any, 'processClaimWithGuard')
      .mockResolvedValue(undefined);
    (service as any).claimRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        address: 'ak_other',
        name: 'myuniquename123.chain',
        status: 'failed',
      });
    const futureExpiry = Date.now() + 10_000;
    lockedChallengeRepository.createQueryBuilder.mockReturnValue({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        nonce: 'a'.repeat(24),
        address: validAddress,
        expires_at: new Date(futureExpiry),
        consumed_at: null,
      }),
    });

    const result = await service.requestChainName({
      address: validAddress,
      name: 'myuniquename123',
      challengeNonce: 'a'.repeat(24),
      challengeExpiresAt: futureExpiry,
      signatureHex: 'b'.repeat(128),
    });

    expect(result.status).toBe('ok');
    expect(lockedClaimRepository.delete).toHaveBeenCalledWith({
      address: 'ak_other',
      name: 'myuniquename123.chain',
      status: 'failed',
    });
    expect(lockedClaimRepository.save).toHaveBeenCalled();
    expect(claimRepository.delete).not.toHaveBeenCalled();
    expect(claimRepository.save).not.toHaveBeenCalled();
    expect(dataSource.transaction).toHaveBeenCalled();
  });

  it('does not delete another address revived in-progress claim during failed-claim replacement race', async () => {
    const {
      service,
      claimRepository,
      lockedClaimRepository,
      lockedChallengeRepository,
    } = getService();
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getNameStateIfPresent').mockResolvedValue(null);
    claimRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      address: 'ak_other',
      name: 'myuniquename123.chain',
      status: 'failed',
    });
    const futureExpiry = Date.now() + 10_000;
    lockedChallengeRepository.createQueryBuilder.mockReturnValue({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        nonce: 'a'.repeat(24),
        address: validAddress,
        expires_at: new Date(futureExpiry),
        consumed_at: null,
      }),
    });
    lockedClaimRepository.delete.mockResolvedValueOnce({ affected: 0 });
    lockedClaimRepository.save.mockRejectedValueOnce({
      driverError: { code: '23505' },
    });

    await expect(
      service.requestChainName({
        address: validAddress,
        name: 'myuniquename123',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: futureExpiry,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow('This name is already being claimed by another address');

    expect(lockedClaimRepository.delete).toHaveBeenCalledWith({
      address: 'ak_other',
      name: 'myuniquename123.chain',
      status: 'failed',
    });
  });

  it('rejects a name already taken on-chain by someone else', async () => {
    const { service, claimRepository } = getService();
    const verifySpy = jest.spyOn(service as any, 'verifyAndConsumeChallenge');
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

    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('does not treat a sponsor-owned on-chain name as this flow when the existing failed claim is for another name', async () => {
    const { service, claimRepository } = getService();
    const verifySpy = jest.spyOn(service as any, 'verifyAndConsumeChallenge');
    jest
      .spyOn(service as any, 'assertSponsorHasFunds')
      .mockResolvedValue(undefined);
    claimRepository.findOne
      .mockResolvedValueOnce({
        address: validAddress,
        name: 'differentfailedname123.chain',
        status: 'failed',
      })
      .mockResolvedValueOnce(null);
    jest
      .spyOn(service as any, 'getNameStateIfPresent')
      .mockResolvedValue({ owner: validAddress });
    jest
      .spyOn(service as any, 'getSponsorAccount')
      .mockReturnValue({ address: validAddress });

    await expect(
      service.requestChainName({
        address: validAddress,
        name: 'myuniquename123',
        challengeNonce: 'a'.repeat(24),
        challengeExpiresAt: Date.now() + 10_000,
        signatureHex: 'b'.repeat(128),
      }),
    ).rejects.toThrow(BadRequestException);

    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('converts unique constraint races into a conflict error', async () => {
    const { service, claimRepository, lockedClaimRepository } = getService();
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
    lockedClaimRepository.save.mockRejectedValueOnce({
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
    jest
      .spyOn(profileSignatureUtil, 'verifyAeAddressSignature')
      .mockReturnValue(false);

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

  describe('processDueClaims', () => {
    it('processes due claims concurrently instead of one at a time', async () => {
      const { service, claimRepository } = getService();
      const dueClaims = Array.from({ length: 8 }, (_, i) => ({
        address: `ak_claim_${i}`,
      }));
      claimRepository.find.mockResolvedValue(dueClaims);

      let active = 0;
      let maxActive = 0;
      const processSpy = jest
        .spyOn(service as any, 'processClaimWithGuard')
        .mockImplementation(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        });

      await service.processDueClaims();

      expect(processSpy).toHaveBeenCalledTimes(8);
      dueClaims.forEach((claim) => {
        expect(processSpy).toHaveBeenCalledWith(claim.address);
      });
      // Bounded concurrency (5), not one sequential await at a time.
      expect(maxActive).toBeGreaterThan(1);
      expect(maxActive).toBeLessThanOrEqual(5);
    });

    it('does not run a second pass while one is already in flight', async () => {
      const { service, claimRepository } = getService();
      claimRepository.find.mockResolvedValue([{ address: 'ak_claim_0' }]);
      let resolveGuard: () => void;
      jest.spyOn(service as any, 'processClaimWithGuard').mockReturnValue(
        new Promise<void>((resolve) => {
          resolveGuard = resolve;
        }),
      );

      const first = service.processDueClaims();
      await service.processDueClaims(); // should return immediately (isCronRunning guard)

      expect(claimRepository.find).toHaveBeenCalledTimes(1);
      resolveGuard!();
      await first;
    });
  });

  describe('on-chain sends', () => {
    const sponsorAddress = 'ak_sponsor';
    const chainName = 'myuniquename123.chain';

    // Stateful claim row and on-chain owner, so a test can run several cron
    // ticks and count what each one sends.
    const setupSends = (initial: Record<string, unknown>) => {
      const ctx = getService();
      const row: any = {
        address: validAddress,
        name: chainName,
        salt: null,
        preclaim_height: null,
        retry_count: 0,
        error: null,
        ...initial,
      };
      const chain: { owner: string | null } = { owner: null };
      const lostWrites: Array<(entry: any) => boolean> = [];

      ctx.claimRepository.findOne.mockImplementation(async () => ({ ...row }));
      ctx.lockedClaimRepository.createQueryBuilder.mockImplementation(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockImplementation(async () => ({ ...row })),
      }));
      ctx.lockedClaimRepository.save.mockImplementation(async (entry) => {
        const lost = lostWrites.findIndex((matches) => matches(entry));
        if (lost !== -1) {
          lostWrites.splice(lost, 1);
          throw new Error('db down');
        }
        Object.assign(row, entry);
        return entry;
      });
      ctx.profileSpendQueueService.getRewardAccount.mockReturnValue({
        address: sponsorAddress,
      });

      const name = {
        preclaim: jest.fn().mockResolvedValue({
          hash: 'th_preclaim',
          nameSalt: 42,
          blockHeight: 99,
        }),
        update: jest.fn().mockResolvedValue({ hash: 'th_update' }),
        transfer: jest.fn().mockImplementation(async () => {
          chain.owner = validAddress;
          return { hash: 'th_transfer' };
        }),
      };
      jest
        .spyOn(ctx.service as any, 'createNameInstance')
        .mockReturnValue(name);
      jest
        .spyOn(ctx.service as any, 'getNameStateIfPresent')
        .mockImplementation(async () =>
          chain.owner ? { owner: chain.owner } : null,
        );
      (buildTxAsync as jest.Mock).mockReset().mockResolvedValue('tx_claim');
      (sendTransaction as jest.Mock)
        .mockReset()
        .mockImplementation(async () => {
          chain.owner = sponsorAddress;
          return { hash: 'th_claim' };
        });

      return {
        ...ctx,
        row,
        chain,
        name,
        loseWriteWhere: (matches: (entry: any) => boolean) =>
          lostWrites.push(matches),
        tick: () => (ctx.service as any).processClaimInternal(validAddress),
      };
    };
    const preclaimed = {
      status: 'preclaimed',
      salt: '42',
      preclaim_height: 99,
    };

    it('preclaims through the sponsor spend queue and stores the salt', async () => {
      const { tick, row, name, service, profileSpendQueueService } = setupSends(
        { status: 'pending' },
      );

      await tick();

      expect(profileSpendQueueService.enqueueSpend).toHaveBeenCalledWith(
        PROFILE_CHAIN_NAME_PRIVATE_KEY,
        expect.any(Function),
      );
      expect((service as any).createNameInstance).toHaveBeenCalledWith(
        chainName,
      );
      expect(name.preclaim).toHaveBeenCalledTimes(1);
      expect(row).toMatchObject({
        status: 'preclaimed',
        salt: '42',
        preclaim_tx_hash: 'th_preclaim',
        preclaim_height: 99,
        error: null,
      });
    });

    it('claims from the sponsor account with the persisted salt', async () => {
      const { tick, row } = setupSends(preclaimed);

      await tick();

      expect(buildTxAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: Tag.NameClaimTx,
          accountId: sponsorAddress,
          name: chainName,
          nameSalt: 42,
        }),
      );
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(row).toMatchObject({
        status: 'claimed',
        claim_tx_hash: 'th_claim',
        error: null,
      });
    });

    it('points the name at the user before transferring it', async () => {
      const { tick, row, chain, name } = setupSends({ status: 'claimed' });
      chain.owner = sponsorAddress;

      await tick();

      expect(name.update).toHaveBeenCalledWith({
        account_pubkey: validAddress,
      });
      expect(name.transfer).toHaveBeenCalledWith(validAddress);
      expect(name.update.mock.invocationCallOrder[0]).toBeLessThan(
        name.transfer.mock.invocationCallOrder[0],
      );
      expect(row).toMatchObject({
        status: 'completed',
        update_tx_hash: 'th_update',
        transfer_tx_hash: 'th_transfer',
        next_retry_at: null,
      });
    });

    it('sends each transaction once across the full flow', async () => {
      const { tick, row, name } = setupSends({ status: 'pending' });

      await tick();
      await tick();
      await tick();

      expect(row.status).toBe('completed');
      expect(name.preclaim).toHaveBeenCalledTimes(1);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(name.update).toHaveBeenCalledTimes(1);
      expect(name.transfer).toHaveBeenCalledTimes(1);
    });

    it('does not resend the claim when the claimed write is lost', async () => {
      const { tick, row, loseWriteWhere } = setupSends(preclaimed);
      loseWriteWhere((entry) => entry.status === 'claimed');

      await tick();
      expect(row).toMatchObject({
        status: 'preclaimed',
        retry_count: 1,
        error: 'db down',
      });

      await tick();
      expect(row.status).toBe('claimed');
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('does not resend the update or transfer when the completed write is lost', async () => {
      const { tick, row, chain, name, loseWriteWhere } = setupSends({
        status: 'claimed',
      });
      chain.owner = sponsorAddress;
      loseWriteWhere((entry) => entry.status === 'completed');

      await tick();
      expect(row).toMatchObject({ status: 'claimed', error: 'db down' });

      await tick();
      expect(row.status).toBe('completed');
      expect(name.update).toHaveBeenCalledTimes(1);
      expect(name.transfer).toHaveBeenCalledTimes(1);
    });

    // The salt is gone with the write, so the orphaned commitment (one preclaim
    // fee) is the accepted cost.
    it('preclaims again when the preclaimed write is lost', async () => {
      const { tick, row, name, loseWriteWhere } = setupSends({
        status: 'pending',
      });
      loseWriteWhere((entry) => entry.status === 'preclaimed');
      name.preclaim.mockResolvedValueOnce({
        hash: 'th_preclaim_lost',
        nameSalt: 41,
        blockHeight: 99,
      });

      await tick();
      expect(row).toMatchObject({
        status: 'pending',
        salt: null,
        error: 'db down',
      });

      await tick();
      expect(name.preclaim).toHaveBeenCalledTimes(2);
      expect(row).toMatchObject({ status: 'preclaimed', salt: '42' });
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('logs instead of throwing when the retry bookkeeping is lost too', async () => {
      const { tick, row, service, loseWriteWhere } = setupSends(preclaimed);
      loseWriteWhere((entry) => entry.status === 'claimed');
      loseWriteWhere((entry) => entry.retry_count === 1);
      const logError = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => undefined);

      await expect(
        (service as any).processClaimWithGuard(validAddress),
      ).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'preclaimed', retry_count: 0 });

      await tick();
      expect(row.status).toBe('claimed');
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('marks a claim that lands after a send timeout as claimed without resending', async () => {
      const { tick, row, chain } = setupSends(preclaimed);
      (sendTransaction as jest.Mock).mockImplementationOnce(async () => {
        chain.owner = sponsorAddress;
        throw new TxTimedOutError(5, 'th_claim');
      });

      await tick();
      expect(row).toMatchObject({ status: 'preclaimed', retry_count: 1 });

      await tick();
      expect(row.status).toBe('claimed');
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });

    // Only one claim of a name can succeed, so the resend cannot pay twice.
    it('resubmits a timed-out claim that has not landed with the same salt', async () => {
      const { tick, row } = setupSends(preclaimed);
      (sendTransaction as jest.Mock).mockRejectedValueOnce(
        new TxTimedOutError(5, 'th_claim'),
      );

      await tick();
      await tick();

      expect(row.status).toBe('claimed');
      expect(
        (buildTxAsync as jest.Mock).mock.calls.map(([tx]) => tx.nameSalt),
      ).toEqual([42, 42]);
    });

    it('resends the update and transfer when the transfer fails', async () => {
      const { tick, row, chain, name } = setupSends({ status: 'claimed' });
      chain.owner = sponsorAddress;
      name.transfer.mockRejectedValueOnce(new Error('node unavailable'));

      await tick();
      expect(row).toMatchObject({
        status: 'claimed',
        error: 'node unavailable',
      });

      await tick();
      expect(row.status).toBe('completed');
      expect(name.update).toHaveBeenCalledTimes(2);
      expect(name.transfer).toHaveBeenCalledTimes(2);
    });

    it('keeps the claim pending without a salt when the preclaim fails', async () => {
      const { tick, row, name } = setupSends({ status: 'pending' });
      name.preclaim.mockRejectedValueOnce(new Error('node unavailable'));

      await tick();

      expect(row).toMatchObject({
        status: 'pending',
        salt: null,
        retry_count: 1,
        error: 'node unavailable',
      });
    });

    it.each([
      { status: 'pending', movedTo: 'preclaimed', fields: {}, owner: null },
      {
        status: 'preclaimed',
        movedTo: 'claimed',
        fields: preclaimed,
        owner: null,
      },
      {
        status: 'claimed',
        movedTo: 'completed',
        fields: {},
        owner: sponsorAddress,
      },
    ])(
      'does not send when a $status claim moves on while queued',
      async ({ status, movedTo, fields, owner }) => {
        const { tick, row, chain, name, profileSpendQueueService } = setupSends(
          { ...fields, status },
        );
        chain.owner = owner;
        profileSpendQueueService.enqueueSpend.mockImplementationOnce(
          async (_key, work) => {
            row.status = movedTo;
            return work();
          },
        );

        await tick();

        expect(name.preclaim).not.toHaveBeenCalled();
        expect(sendTransaction).not.toHaveBeenCalled();
        expect(name.update).not.toHaveBeenCalled();
        expect(name.transfer).not.toHaveBeenCalled();
        expect(row.status).toBe(movedTo);
      },
    );

    it('does not update or transfer a name owned by an unexpected address', async () => {
      const { tick, row, chain, name } = setupSends({ status: 'claimed' });
      chain.owner = 'ak_stranger';

      await tick();

      expect(name.update).not.toHaveBeenCalled();
      expect(name.transfer).not.toHaveBeenCalled();
      expect(row).toMatchObject({
        status: 'claimed',
        retry_count: 1,
        error: `Chain name ${chainName} is owned by an unexpected address`,
      });
    });

    it('completes without claiming when the user already owns the name', async () => {
      const { tick, row, chain } = setupSends(preclaimed);
      chain.owner = validAddress;

      await tick();

      expect(row.status).toBe('completed');
      expect(sendTransaction).not.toHaveBeenCalled();
    });
  });
});
